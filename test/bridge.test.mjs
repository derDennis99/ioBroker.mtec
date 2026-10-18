// Integration: real MQTT client against a local aedes broker, the ioBroker adapter as a fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Aedes } from 'aedes';
import { ROUNDS } from './fixtures/mtecmqtt.mjs';

const require = createRequire(import.meta.url);
const mqtt = require('mqtt');
const { Bridge } = require('../lib/bridge.js');
const { dayKey } = require('../lib/analysis.js');

let broker;
let server;
let port;

before(async () => {
    broker = await Aedes.createBroker();
    broker.authenticate = (client, username, password, cb) => {
        const ok = username === 'reader' && password?.toString() === 'secret';
        cb(ok ? null : Object.assign(new Error('auth'), { returnCode: 4 }), ok);
    };
    server = createServer(broker.handle);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
});

after(async () => {
    await new Promise(r => broker.close(r));
    server.close();
});

function fakeAdapter() {
    const states = {};
    const objects = {};
    const logs = [];
    const log = level => m => logs.push(`${level}: ${m}`);
    return {
        namespace: 'mtec.0',
        states,
        objects,
        logs,
        log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
        async setStateAsync(id, state, ack) {
            states[id] = typeof state === 'object' && state !== null ? state : { val: state, ack };
        },
        async setStateChangedAsync(id, state, ack) {
            const next = typeof state === 'object' && state !== null ? state : { val: state, ack };
            if (!states[id] || states[id].val !== next.val) {
                states[id] = next;
            }
        },
        async getStateAsync(id) {
            return states[id] || null;
        },
        async getObjectAsync(id) {
            return objects[id] || null;
        },
        async delObjectAsync(id) {
            delete objects[id];
            delete states[id];
        },
        async extendObjectAsync(id, obj) {
            objects[id] = obj;
        },
        async setObjectNotExistsAsync(id, obj) {
            objects[id] ??= obj;
        },
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: timer => clearInterval(timer),
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: timer => clearTimeout(timer),
    };
}

const config = (password, extra = {}) => ({
    host: '127.0.0.1',
    port,
    username: 'reader',
    password,
    topicHeatpump: 'energy/heatpump/telemetry',
    topicButler: 'energy/butler/telemetry',
    batteryCapacityKwh: 15,
    batteryMinSoc: 10,
    priceImportCt: 30,
    priceExportCt: 8,
    staleSeconds: 20,
    ...extra,
});

async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

function publish(topic, body, qos = 1) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return new Promise((resolve, reject) =>
        broker.publish({ topic, payload, qos, retain: false, cmd: 'publish', dup: false }, e =>
            e ? reject(e) : resolve(),
        ),
    );
}

test('json: creates objects, connects and writes values with the time of measurement', async () => {
    const adapter = fakeAdapter();
    const bridge = new Bridge(adapter, config('secret'), mqtt.connect);
    const subscribed = once(broker, 'subscribe');
    await bridge.start();
    try {
        assert.equal(adapter.objects['heatpump.flow_temperature_c'].common.unit, '°C');
        assert.deepEqual(adapter.objects['butler.battery_soc_percent'].common.name, {
            en: 'Battery state of charge',
            de: 'Batterieladestand',
        });
        assert.equal(adapter.objects['butler.info.serial'], undefined, 'serial number only with MTECmqtt');
        assert.equal(adapter.states['heatpump.info.stale'].val, true);

        const [subscriptions] = await subscribed;
        assert.deepEqual(subscriptions.map(s => [s.topic, s.qos]).sort(), [
            ['energy/butler/telemetry', 1],
            ['energy/heatpump/telemetry', 1],
        ]);
        await until(() => adapter.states['info.connection']?.val === true);

        const ts = Date.now() - 1000;
        await publish('energy/butler/telemetry', {
            name: 'butler',
            fields: { battery_soc_percent: 81, pv_total_power_w: 0, grid_import_power_w: 120 },
            timestamp: ts,
        });
        await until(() => adapter.states['butler.battery_soc_percent']);

        assert.deepEqual(adapter.states['butler.battery_soc_percent'], { val: 81, ack: true, ts, q: 0 });
        assert.equal(adapter.states['butler.pv_total_power_w'].val, 0);
        assert.deepEqual(adapter.states['butler.pv1_power_w'], { val: null, ack: true, ts, q: 0x82 });
        assert.equal(adapter.states['butler.info.lastMeasurement'].val, ts);
        assert.equal(adapter.states['butler.info.stale'].val, false);
        assert.equal(adapter.states['heatpump.info.stale'].val, true, 'the heat pump has not sent anything yet');

        // analysis: objects exist, incomplete message → no house consumption, but battery content
        assert.equal(adapter.objects['analysis.house_power_w'].common.unit, 'W');
        assert.equal(adapter.objects['analysis.today.cost'].common.unit, '€');
        assert.equal(adapter.objects['analysis.cost_now_per_h'].common.unit, '€/h');
        assert.equal(adapter.states['analysis.house_power_w'].val, null);
        assert.equal(adapter.states['analysis.battery_energy_kwh'].val, 12.15);

        // complete message → house consumption and cost (price 30 ct)
        await publish('energy/butler/telemetry', {
            name: 'butler',
            fields: {
                battery_soc_percent: 81,
                pv_total_power_w: 3000,
                grid_import_power_w: 1000,
                grid_export_power_w: 0,
                battery_charge_power_w: 500,
                battery_discharge_power_w: 0,
            },
            timestamp: ts + 5000,
        });
        await until(() => adapter.states['analysis.house_power_w']?.val === 3500);
        assert.equal(adapter.states['analysis.cost_now_per_h'].val, 0.3);
        assert.equal(adapter.states['analysis.today.date'].val.length, 10);
        assert.match(
            adapter.states['analysis.battery_status_text'].val,
            /^full in /,
            'English without system language',
        );

        // a duplicate changes nothing
        adapter.states['butler.battery_soc_percent'] = 'unchanged';
        await publish('energy/butler/telemetry', {
            name: 'butler',
            fields: { battery_soc_percent: 99 },
            timestamp: ts,
        });
        await publish('energy/heatpump/telemetry', {
            name: 'heatpump',
            fields: { cop: 4.2, new_counter_kwh: 7 },
            timestamp: ts,
        });
        await until(() => adapter.states['heatpump.cop']);
        assert.equal(adapter.states['butler.battery_soc_percent'], 'unchanged');
        assert.equal(adapter.states['heatpump.cop'].val, 4.2);
        assert.equal(adapter.objects['heatpump.new_counter_kwh'].common.type, 'number');
        assert.ok(adapter.logs.some(l => l.includes('new field "new_counter_kwh"')));

        // broken message: warning, no crash
        await publish('energy/heatpump/telemetry', '{oops', 0);
        await until(() => adapter.logs.some(l => l.startsWith('warn') && l.includes('not valid JSON')));
    } finally {
        await bridge.stop();
    }
    assert.equal(adapter.states['info.connection'].val, false);
});

test('wrong password: no connection, error in the log', async () => {
    const adapter = fakeAdapter();
    const bridge = new Bridge(adapter, config('wrong'), mqtt.connect);
    await bridge.start();
    try {
        await until(() => adapter.logs.some(l => l.startsWith('warn: MQTT')));
        assert.notEqual(adapter.states['info.connection']?.val, true);
    } finally {
        await bridge.stop();
    }
});

test('mtecmqtt: single plain text values become one record per loop', async () => {
    const adapter = fakeAdapter();
    const cfg = config('secret', { profile: 'mtecmqtt', topicHeatpump: '', mtecTopicPrefix: 'MTEC', language: 'de' });
    const bridge = new Bridge(adapter, cfg, mqtt.connect, { mtecQuietMs: 150 });
    const subscribed = once(broker, 'subscribe');
    await bridge.start();
    try {
        const [subscriptions] = await subscribed;
        assert.deepEqual(
            subscriptions.map(s => [s.topic, s.qos]),
            [['MTEC/+/#', 0]],
        );
        assert.equal(adapter.objects['heatpump.cop'], undefined, 'no heat pump configured');
        assert.equal(adapter.objects['butler.info.serial'].common.role, 'info.serial');
        await until(() => adapter.states['info.connection']?.val === true);

        // Home Assistant discovery is not subscribed, other serial numbers are ignored
        await publish('homeassistant/sensor/MTEC_SN0000000001/pv/config', '{}', 0);
        const start = Date.now();
        for (const [name, val] of Object.entries(ROUNDS['now-base'])) {
            await publish(`MTEC/SN0000000001/now-base/${name}`, val, 0);
        }
        await publish('MTEC/SN0000000002/now-base/pv', '999', 0);
        for (const [name, val] of Object.entries(ROUNDS['now-grid'])) {
            await publish(`MTEC/SN0000000001/now-grid/${name}`, val, 0);
        }
        await until(() => adapter.states['analysis.house_power_w']);
        assert.equal(adapter.states['butler.info.serial'].val, 'SN0000000001');
        assert.equal(adapter.states['butler.grid_import_power_w'].val, 628);
        assert.equal(adapter.states['butler.battery_charge_power_w'].val, 1036);
        assert.equal(adapter.states['butler.grid_phase_c_power_signed_w'].val, -218);
        assert.equal(adapter.states['butler.pv1_power_w'], undefined, 'now-pv has not been sent yet');
        assert.equal(
            adapter.states['butler.pv_total_power_w'].val,
            2300,
            'the foreign serial number did not overwrite',
        );
        const ts = adapter.states['butler.info.lastMeasurement'].val;
        assert.ok(ts >= start && ts <= Date.now(), 'time of receipt');
        assert.equal(adapter.states['butler.info.stale'].val, false);
        assert.equal(adapter.states['analysis.house_power_w'].val, 1892, '2300 + 628 − 1036');
        assert.equal(adapter.states['analysis.cost_now_per_h'].val, 0.19);
        assert.match(adapter.states['analysis.battery_status_text'].val, /^voll in /, 'German with system language de');
        assert.equal(adapter.objects['butler.mtecmqtt.now_base.battery_voltage'].common.unit, 'V');
        assert.equal(adapter.states['butler.mtecmqtt.now_base.battery_voltage'].val, 51.2);
        assert.equal(adapter.states['butler.mtecmqtt.now_base.api_date'].val, '2026-10-17 12:00:00');
        assert.equal(adapter.objects['butler.mtecmqtt.now_grid'].type, 'channel');
        assert.ok(adapter.logs.some(l => l.startsWith('warn') && l.includes('SN0000000002')));
        assert.ok(!adapter.logs.some(l => l.includes('homeassistant')));
    } finally {
        await bridge.stop();
    }
});

test('mtecmqtt: daily counters replace the estimate', async () => {
    const adapter = fakeAdapter();
    const cfg = config('secret', { profile: 'mtecmqtt', topicHeatpump: '', mtecSerial: 'SN0000000001' });
    const bridge = new Bridge(adapter, cfg, mqtt.connect);
    await bridge.createObjects();
    assert.equal(adapter.states['butler.info.serial'].val, 'SN0000000001', 'configured serial number');
    const noon = new Date(2026, 9, 17, 12, 0, 0).getTime();
    const loop = async (t, groups) => {
        for (const group of groups) {
            for (const [name, val] of Object.entries(ROUNDS[group])) {
                await bridge.handleMessage(`MTEC/SN0000000001/${group}/${name}`, Buffer.from(val), t);
            }
        }
        await bridge.flushSource(bridge.sources[0], t + 2000);
    };
    await loop(noon, ['now-base']);
    await loop(noon + 12_000, ['now-base', 'day']);
    assert.equal(adapter.states['analysis.today.date'].val, '2026-10-17');
    assert.equal(adapter.states['analysis.today.pv_kwh'].val, 6.7);
    assert.equal(adapter.states['analysis.today.grid_import_kwh'].val, 4.3);
    assert.equal(adapter.states['analysis.today.house_kwh'].val, 10.4, 'same as MTECmqtt consumption_day');
    assert.equal(adapter.states['analysis.today.cost'].val, 1.29);
    assert.equal(adapter.states['butler.mtecmqtt.day.consumption_day'].val, 10.4);
    await bridge.stop();
});

test("renamed data points: today's values are taken over, old objects deleted", async () => {
    const adapter = fakeAdapter();
    const today = dayKey(Date.now());
    const old = [
        'analysis.cost_now_eur_h',
        'analysis.savings_now_eur_h',
        'analysis.grid_balance_eur_h',
        'analysis.today.cost_eur',
        'analysis.today.savings_eur',
    ];
    for (const id of old) {
        adapter.objects[id] = { type: 'state', common: {}, native: {} };
    }
    adapter.states['analysis.today.date'] = { val: today, ack: true };
    adapter.states['analysis.today.pv_kwh'] = { val: 4, ack: true };
    adapter.states['analysis.today.cost_eur'] = { val: 1.23, ack: true, ts: 1 };
    adapter.states['analysis.today.savings_eur'] = { val: 2.5, ack: true, ts: 1 };
    adapter.states['analysis.cost_now_eur_h'] = { val: 0.3, ack: true };

    const bridge = new Bridge(adapter, config('secret'), mqtt.connect);
    await bridge.createObjects();
    await bridge.migrateRenamedStates();
    await bridge.restoreAnalysis();

    for (const id of old) {
        assert.equal(adapter.objects[id], undefined, id);
        assert.equal(adapter.states[id], undefined, id);
    }
    assert.deepEqual(adapter.states['analysis.today.cost'], { val: 1.23, ack: true, ts: 1 });
    assert.equal(adapter.states['analysis.today.savings'].val, 2.5);
    assert.equal(bridge.analysis.today.cost, 1.23);
    assert.equal(bridge.analysis.today.pv_kwh, 4);
    assert.equal(adapter.logs.filter(l => l.includes('was renamed')).length, 5);

    // a second start finds nothing to migrate
    adapter.logs.length = 0;
    await bridge.migrateRenamedStates();
    assert.equal(adapter.logs.length, 0);
});
