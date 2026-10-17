#!/usr/bin/env node
// Checks a broker with the input profile json against the adapter's field definitions, read-only.
//
//   node tools/mqtt-check.mjs --host <broker> [--port 1883] [--user <user>] [--seconds 15]
//
// The script asks for the password (hidden input), or takes it from MQTT_PASSWORD.
// It is never printed or stored.

import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const mqtt = require('mqtt');
const { DEVICES } = require('../lib/fields.js');

const { values: args } = parseArgs({
    options: {
        host: { type: 'string' },
        port: { type: 'string', default: '1883' },
        user: { type: 'string' },
        seconds: { type: 'string', default: '15' },
    },
});

if (!args.host) {
    console.error('Please name the broker: node tools/mqtt-check.mjs --host <broker> [--port 1883] [--user <user>] [--seconds 15]');
    process.exit(2);
}

const TOPICS = {
    'energy/heatpump/telemetry': 'heatpump',
    'energy/butler/telemetry': 'butler',
};

const seen = Object.fromEntries(Object.keys(TOPICS).map(t => [t, { count: 0, invalid: 0, fields: new Map(), ages: [], last: null }]));

/** Reads an input without showing it. */
function askHidden(question) {
    return new Promise(resolve => {
        const stdin = process.stdin;
        process.stdout.write(question);
        stdin.setRawMode(true);
        stdin.setEncoding('utf8');
        stdin.resume();
        let input = '';
        const onData = chunk => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    stdin.off('data', onData);
                    stdin.setRawMode(false);
                    stdin.pause();
                    process.stdout.write('\n');
                    resolve(input);
                    return;
                }
                if (ch === '\u0003') {
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (ch === '\b' || ch === '\u007f') {
                    input = input.slice(0, -1);
                } else {
                    input += ch;
                }
            }
        };
        stdin.on('data', onData);
    });
}

let password = process.env.MQTT_PASSWORD;
if (password) {
    console.log('Password from the environment variable MQTT_PASSWORD');
} else if (args.user && process.stdin.isTTY) {
    password = await askHidden(`Password for ${args.user} (hidden): `);
}
if (args.user && !password) {
    console.warn('Note: no password, connecting without one.');
}

console.log(`Connecting to ${args.host}:${args.port} …`);
let connected = false;
const giveUp = setTimeout(() => {
    console.error('No answer from the broker after 15 s.');
    process.exit(2);
}, 15_000);

const client = mqtt.connect(`mqtt://${args.host}:${args.port}`, {
    username: args.user,
    password: password || undefined,
    clientId: `mtec_check_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
});

client.on('error', err => {
    console.error(`Connection error: ${err.message}`);
    process.exit(2);
});

client.on('close', () => {
    if (!connected) {
        console.error('The connection was closed before it was established.');
        process.exit(2);
    }
});

client.on('connect', () => {
    connected = true;
    clearTimeout(giveUp);
    console.log(`Connected${args.user ? ` as ${args.user}` : ''}. Listening for ${args.seconds} s …`);
    client.subscribe(Object.keys(TOPICS), { qos: 1 }, (err, granted) => {
        if (err) {
            console.error(`Subscribing failed: ${err.message}`);
            process.exit(2);
        }
        for (const g of granted) {
            if (g.qos === 128) {
                console.error(`Subscription refused: ${g.topic}`);
            }
        }
    });
    setTimeout(report, Number(args.seconds) * 1000);
});

client.on('message', (topic, payload) => {
    const s = seen[topic];
    if (!s) {
        return;
    }
    s.count++;
    if (s.count === 1) {
        console.log(`  first message on ${topic}`);
    }
    let msg;
    try {
        msg = JSON.parse(payload.toString());
    } catch {
        s.invalid++;
        return;
    }
    if (!msg?.fields || typeof msg.timestamp !== 'number') {
        s.invalid++;
        return;
    }
    s.last = msg;
    s.ages.push(Date.now() - msg.timestamp);
    for (const [k, v] of Object.entries(msg.fields)) {
        const types = s.fields.get(k) ?? new Set();
        types.add(v === null ? 'null' : typeof v);
        s.fields.set(k, types);
    }
});

function report() {
    let problems = 0;
    for (const [topic, s] of Object.entries(seen)) {
        const device = TOPICS[topic];
        const known = Object.keys(DEVICES[device].fields);
        console.log(`\n=== ${topic} → ${device}`);
        console.log(`Messages: ${s.count}${s.invalid ? `, invalid: ${s.invalid}` : ''}`);
        if (!s.last) {
            console.log('No valid message received.');
            problems++;
            continue;
        }
        const ages = s.ages.map(a => a / 1000);
        const minAge = Math.min(...ages);
        let clockNote = '';
        if (minAge < -60) {
            clockNote = '  ⚠ timestamps more than 60 s in the future – the adapter discards these messages, check the clocks';
        } else if (minAge < -10) {
            clockNote = '  ⚠ timestamps clearly in the future – check the clocks';
        } else if (minAge < -1) {
            clockNote = '  (clocks differ by a few seconds – no problem for the adapter)';
        }
        console.log(`Age on receipt: min ${minAge.toFixed(1)} s, max ${Math.max(...ages).toFixed(1)} s${clockNote}`);
        const missing = known.filter(f => !s.fields.has(f));
        const unknown = [...s.fields.keys()].filter(f => !known.includes(f));
        const nonNumeric = [...s.fields].filter(([, t]) => [...t].some(x => x !== 'number')).map(([f, t]) => `${f} (${[...t].join('/')})`);
        console.log(`Fields: ${s.fields.size} received, ${known.length} expected`);
        if (missing.length) {
            console.log(`  never sent: ${missing.join(', ')}`);
        }
        if (unknown.length) {
            console.log(`  unknown (the adapter creates them as generic numbers): ${unknown.join(', ')}`);
        }
        if (nonNumeric.length) {
            console.log(`  ⚠ not always a number: ${nonNumeric.join(', ')}`);
            problems++;
        }
        console.log('Last values:');
        for (const [k, v] of Object.entries(s.last.fields)) {
            console.log(`  ${k.padEnd(46)} ${v}`);
        }
    }
    client.end(true, () => process.exit(problems ? 1 : 0));
}
