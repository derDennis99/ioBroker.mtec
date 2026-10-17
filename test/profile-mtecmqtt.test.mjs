// Profile mtecmqtt with messages modelled on MTECmqtt 2.1.0 (see fixtures/mtecmqtt.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ROUNDS, SERIAL } from './fixtures/mtecmqtt.mjs';

const require = createRequire(import.meta.url);
const { MtecmqttSource, guessUnit, parseValue, groupFields } = require('../lib/profiles/mtecmqtt.js');
const { Q_SENSOR_NOT_REPORTED } = require('../lib/profiles/json.js');

const T0 = 1_791_956_345_000;

const source = (o = {}) => new MtecmqttSource({ prefix: 'MTEC', staleMs: 20_000, slowStaleMs: 180_000, now: T0, ...o });

/**
 * Feeds the values of the given groups like one MTECmqtt loop, 20 ms apart; returns all results.
 *
 * @param src
 * @param groups
 * @param start
 * @param root0
 * @param root0.serial
 * @param root0.values
 */
function feed(src, groups, start, { serial = SERIAL, values = {} } = {}) {
    const out = [];
    let ts = start;
    for (const group of groups) {
        for (const [name, val] of Object.entries(values[group] ?? ROUNDS[group])) {
            out.push(...src.handle(`MTEC/${serial}/${group}/${name}`, Buffer.from(val), ts));
            ts += 20;
        }
    }
    return out;
}

const byField = rec => Object.fromEntries(rec.updates.map(u => [u.field, u]));
const extra = (rec, id) => rec.extras.find(e => e.id === id);

test('subscribes to the prefix with QoS 0, with or without serial number', () => {
    assert.deepEqual(source().subscriptions, [{ topic: 'MTEC/+/#', qos: 0 }]);
    assert.deepEqual(source({ prefix: '/home/MTEC/', serial: SERIAL }).subscriptions, [
        { topic: `home/MTEC/${SERIAL}/#`, qos: 0 },
    ]);
    assert.deepEqual(source({ prefix: '' }).subscriptions, [{ topic: 'MTEC/+/#', qos: 0 }]);
    assert.equal(source().matches('MTEC/x/now-base/pv'), true);
    assert.equal(source().matches('homeassistant/sensor/MTEC_x/pv/config'), false);
});

test('one now-base loop becomes one record with our field names', () => {
    const s = source();
    const early = feed(s, ['now-base'], T0);
    assert.deepEqual(early, [{ type: 'serial', serial: SERIAL }], 'nothing is processed before the loop is complete');
    assert.equal(s.pending, true);

    const [rec] = s.flush(T0 + 2_500);
    assert.equal(s.pending, false);
    assert.equal(rec.type, 'record');
    assert.equal(rec.device, 'butler');
    assert.equal(rec.ts, T0, 'receipt of the first value');
    assert.equal(rec.main, true);
    assert.deepEqual(rec.groups, ['now-base']);
    const u = byField(rec);
    assert.equal(u.battery_soc_percent.val, 38.4);
    assert.equal(u.battery_power_signed_w.val, -1036);
    assert.equal(u.battery_charge_power_w.val, 1036);
    assert.equal(u.battery_discharge_power_w.val, 0);
    assert.equal(u.battery_charge_discharge_status_code.val, 1);
    assert.equal(u.grid_total_power_signed_w.val, -628);
    assert.equal(u.grid_import_power_w.val, 628);
    assert.equal(u.grid_export_power_w.val, 0);
    assert.equal(u.pv_total_power_w.val, 2300);
    assert.equal(u.inverter_ac_power_signed_w.val, 1450);
    assert.equal(u.inverter_operating_status_code.val, 2);
    assert.equal(rec.updates.length, 11, 'only fields of now-base; phases and PV strings stay untouched');
    assert.equal(u.grid_phase_a_power_signed_w, undefined);
    assert.equal(s.lastTs, T0);
    assert.equal(s.isStale(T0 + 20_000), false);
    assert.equal(s.isStale(T0 + 20_001), true);

    // values without a counterpart are kept
    assert.equal(extra(rec, 'butler.mtecmqtt.now_base.battery_voltage').val, 51.2);
    assert.equal(extra(rec, 'butler.mtecmqtt.now_base.battery_voltage').common.unit, 'V');
    assert.equal(extra(rec, 'butler.mtecmqtt.now_base.consumption').common.role, 'value.power');
    assert.deepEqual(extra(rec, 'butler.mtecmqtt.now_base.api_date'), {
        id: 'butler.mtecmqtt.now_base.api_date',
        val: '2026-10-17 12:00:00',
        common: { name: 'MTECmqtt now-base/api_date', type: 'string', role: 'text', read: true, write: false },
        channels: [
            { id: 'butler.mtecmqtt', name: { en: 'Further values from MTECmqtt', de: 'Weitere Werte von MTECmqtt' } },
            { id: 'butler.mtecmqtt.now_base', name: 'now-base' },
        ],
    });
    assert.equal(rec.extras.length, 7);
    assert.equal(rec.counters, null);
});

test('"missing = null" applies per group', () => {
    const s = source();
    const values = { 'now-base': { ...ROUNDS['now-base'] } };
    delete values['now-base'].battery;
    values['now-base'].battery_soc = 'n/a';
    feed(s, ['now-base'], T0, { values });
    const [rec] = s.flush(T0 + 2_500);
    const u = byField(rec);
    for (const f of [
        'battery_power_signed_w',
        'battery_charge_power_w',
        'battery_discharge_power_w',
        'battery_soc_percent',
    ]) {
        assert.deepEqual(u[f], { field: f, val: null, q: Q_SENSOR_NOT_REPORTED }, f);
    }
    assert.deepEqual(rec.rejected, ['now-base/battery_soc']);
    assert.equal(u.grid_import_power_w.val, 628);
});

test('slow groups set only their own fields and are not a main record', () => {
    const s = source();
    feed(s, ['now-grid'], T0);
    const [rec] = s.flush(T0 + 2_500);
    assert.equal(rec.main, false);
    assert.deepEqual(
        rec.updates.map(u => [u.field, u.val]),
        [
            ['grid_phase_a_power_signed_w', -210],
            ['grid_phase_b_power_signed_w', -200],
            ['grid_phase_c_power_signed_w', -218],
        ],
    );
    assert.equal(s.lastTs, null);
    assert.equal(s.isStale(T0), true, 'without now-base the device stays stale');
    assert.equal(extra(rec, 'butler.mtecmqtt.now_grid.grid_fequency').common.unit, 'Hz');
});

test('a whole loop with several groups becomes one record', () => {
    const s = source();
    feed(s, ['now-base', 'now-pv', 'day'], T0);
    const [rec] = s.flush(T0 + 3_000);
    assert.deepEqual(rec.groups, ['now-base', 'now-pv', 'day']);
    assert.equal(rec.main, true);
    assert.equal(byField(rec).pv1_power_w.val, 1150);
    assert.deepEqual(rec.counters, {
        grid_export_kwh: 0,
        grid_import_kwh: 4.3,
        battery_charge_kwh: 2.1,
        battery_discharge_kwh: 1.5,
        pv_kwh: 6.7,
    });
    assert.equal(extra(rec, 'butler.mtecmqtt.day.pv_day').common.unit, 'kWh');
    assert.equal(extra(rec, 'butler.mtecmqtt.day.autarky_rate_day').common.unit, '%');
});

test('a repeated value starts a new record (next loop before the quiet period)', () => {
    const s = source();
    feed(s, ['now-base'], T0);
    const values = { 'now-base': { ...ROUNDS['now-base'], pv: '2500' } };
    const out = feed(s, ['now-base'], T0 + 1_000, { values });
    const recs = out.filter(r => r.type === 'record');
    assert.equal(recs.length, 1);
    assert.equal(byField(recs[0]).pv_total_power_w.val, 2300);
    const [next] = s.flush(T0 + 4_000);
    assert.equal(next.ts, T0 + 1_000);
    assert.equal(byField(next).pv_total_power_w.val, 2500);
});

test('slow groups expire on their own limit and come back', () => {
    const s = source();
    assert.deepEqual(s.expire(T0 + 180_000), [], 'not before the limit');
    const [exp] = s.expire(T0 + 180_001);
    assert.equal(exp.type, 'expired');
    assert.deepEqual(exp.groups, ['now-grid', 'now-pv'], 'only groups with fields of ours');
    assert.equal(exp.updates.length, 5);
    assert.ok(exp.updates.every(u => u.val === null && u.q === Q_SENSOR_NOT_REPORTED));
    assert.deepEqual(s.expire(T0 + 200_000), [], 'reported only once');

    feed(s, ['now-grid'], T0 + 200_000);
    const [rec] = s.flush(T0 + 203_000);
    assert.deepEqual(rec.restored, ['now-grid']);
    assert.deepEqual(s.expire(T0 + 300_000), []);
    assert.deepEqual(s.expire(T0 + 380_001)[0].groups, ['now-grid']);
});

test('only one serial number per instance', () => {
    const auto = source();
    feed(auto, ['now-base'], T0);
    const foreign = feed(auto, ['now-base'], T0 + 100, { serial: 'OTHER' });
    assert.ok(foreign.every(r => r.type === 'foreign' && r.serial === 'OTHER'));
    assert.equal(auto.serial, SERIAL);

    const fixed = source({ serial: SERIAL });
    const out = feed(fixed, ['now-base'], T0);
    assert.equal(out.length, 0, 'no serial event with a configured serial number');
    assert.equal(fixed.handle('MTEC/OTHER/now-base/pv', '1', T0)[0].type, 'foreign');
});

test('unexpected topics are skipped', () => {
    const s = source();
    assert.equal(s.handle('MTEC/status', 'online', T0)[0].type, 'skipped');
    assert.equal(s.handle(`MTEC/${SERIAL}/now-base/pv/extra`, '1', T0)[0].type, 'skipped');
    assert.equal(s.handle(`MTEC/${SERIAL}//pv`, '1', T0)[0].type, 'skipped');
    assert.equal(s.pending, false);
});

test('values: numbers, text and a stable type per data point', () => {
    assert.equal(parseValue('38.400'), 38.4);
    assert.equal(parseValue('-628'), -628);
    assert.equal(parseValue('0'), 0);
    assert.equal(parseValue(' 12 '), 12);
    assert.equal(parseValue(''), '');
    assert.equal(parseValue('0x10'), '0x10');
    assert.equal(parseValue('27.52.4.0'), '27.52.4.0');

    const s = source();
    feed(s, ['config'], T0);
    const [first] = s.flush(T0 + 2_500);
    assert.equal(extra(first, 'butler.mtecmqtt.config.firmware_version').common.type, 'string');
    assert.equal(extra(first, 'butler.mtecmqtt.config.serial_no').val, SERIAL);
    s.handle(`MTEC/${SERIAL}/now-pv/pv_voltage_1`, '350.200', T0 + 10_000);
    s.flush(T0 + 12_000);
    s.handle(`MTEC/${SERIAL}/now-pv/pv_voltage_1`, 'error', T0 + 20_000);
    const [later] = s.flush(T0 + 22_000);
    assert.equal(
        extra(later, 'butler.mtecmqtt.now_pv.pv_voltage_1').val,
        null,
        'text in a number data point becomes null',
    );
});

test('units are only guessed where the naming is clear', () => {
    assert.equal(guessUnit('now-base', 'battery_soc'), '%');
    assert.equal(guessUnit('now-battery', 'battery_soh'), '%');
    assert.equal(guessUnit('now-battery', 'battery_cell_t_max'), '°C');
    assert.equal(guessUnit('now-battery', 'battery_cell_v_min'), 'V');
    assert.equal(guessUnit('now-inverter', 'inverter_temp1'), '°C');
    assert.equal(guessUnit('now-inverter', 'inverter_a'), 'W');
    assert.equal(guessUnit('now-backup', 'backup_frequency_a'), 'Hz');
    assert.equal(guessUnit('now-backup', 'backup_current_b'), 'A');
    assert.equal(guessUnit('now-base', 'mode'), null);
    assert.equal(guessUnit('total', 'grid_purchase_total'), 'kWh');
    assert.equal(guessUnit('total', 'own_consumption_total'), '%');
    assert.equal(guessUnit('config', 'grid_inject_limit'), null);
    assert.deepEqual(groupFields('now-base').length, 11);
    assert.deepEqual(groupFields('day'), []);
});
