'use strict';

/**
 * Input profile `mtecmqtt`: Energy Butler via the MQTT output of MTECmqtt
 * (https://github.com/croedel/MTECmqtt, checked against version 2.1.0). Details: docs/profile-mtecmqtt.md
 *
 * - One topic per value, `<prefix>/<serial>/<group>/<name>`, plain text payload, no timestamp, QoS 0.
 * - MTECmqtt reads a group via Modbus and then publishes its values one by one. Every loop
 *   (about 10 s) publishes `now-base`; the other `now-*` groups take turns, one per loop, so each
 *   comes only about every 50 s. `day`, `total` and `config` follow every few minutes.
 * - Values are collected until the topics have been quiet for `quietMs`, or until a value repeats
 *   (the next loop has started), and are then processed as one record. The record's time is the
 *   receipt of its first value, since MTECmqtt sends no time of measurement.
 * - "Missing = null" applies per group: a group present in the record sets its missing fields to
 *   null, groups not present keep their values. Fields of the slow groups are set to null once
 *   their group has not been seen for `slowStaleMs`.
 * - Values without a counterpart among our fields are kept under `butler.mtecmqtt.<group>.<name>`.
 * - Daily energy counters (group `day`) are handed to the analysis and replace the estimate there.
 *
 * Signs (derived from MTECmqtt's README, its consumption formula and its evcc template, still to be
 * confirmed with real data): `grid_power` + = export, − = import; `battery` + = discharging.
 * Both match our fields.
 */

const { t } = require('../fields');
const { Q_SENSOR_NOT_REPORTED } = require('./json');

const MAIN_GROUP = 'now-base';
const SLOW_GROUPS = ['now-grid', 'now-inverter', 'now-backup', 'now-battery', 'now-pv'];

/** Default quiet period that ends a record. Values of one loop follow each other within milliseconds. */
const QUIET_MS = 2_000;
/** Safety net: a record never collects longer than this. */
const MAX_BATCH_MS = 30_000;

/** MTECmqtt name → our field, per group. */
const FIELD_MAP = {
    'now-base': {
        battery_soc: 'battery_soc_percent',
        battery: 'battery_power_signed_w',
        battery_mode: 'battery_charge_discharge_status_code',
        grid_power: 'grid_total_power_signed_w',
        pv: 'pv_total_power_w',
        inverter: 'inverter_ac_power_signed_w',
        inverter_status: 'inverter_operating_status_code',
    },
    'now-grid': {
        grid_a: 'grid_phase_a_power_signed_w',
        grid_b: 'grid_phase_b_power_signed_w',
        grid_c: 'grid_phase_c_power_signed_w',
    },
    'now-pv': {
        pv_1: 'pv1_power_w',
        pv_2: 'pv2_power_w',
    },
};

/** Fields derived from a signed field: [signed field, field for the positive part, field for the negative part]. */
const SPLIT = [
    ['battery_power_signed_w', 'battery_discharge_power_w', 'battery_charge_power_w'],
    ['grid_total_power_signed_w', 'grid_export_power_w', 'grid_import_power_w'],
];

/** Daily counters of group `day` (kWh) → keys of the analysis' daily values. */
const DAY_COUNTERS = {
    pv_day: 'pv_kwh',
    grid_purchase_day: 'grid_import_kwh',
    grid_feed_day: 'grid_export_kwh',
    battery_charge_day: 'battery_charge_kwh',
    battery_discharge_day: 'battery_discharge_kwh',
};

/** MTECmqtt formats floats as "{:.3f}" and integers plainly; anything else is text. */
const NUMBER = /^[-+]?\d+(\.\d+)?$/;

/** @param {string} text */
function parseValue(text) {
    const s = text.trim();
    return NUMBER.test(s) ? Number(s) : s;
}

/**
 * All our fields a group sets, including the derived ones.
 *
 * @param {string} group
 */
function groupFields(group) {
    const fields = Object.values(FIELD_MAP[group] || {});
    for (const [signed, pos, neg] of SPLIT) {
        if (fields.includes(signed)) {
            fields.push(pos, neg);
        }
    }
    return fields;
}

const ROLE_BY_UNIT = {
    W: 'value.power',
    kWh: 'value.energy',
    V: 'value.voltage',
    A: 'value.current',
    Hz: 'value.frequency',
    '°C': 'value.temperature',
};

/**
 * Unit of an unmapped value, derived from MTECmqtt's naming. Unclear names get no unit.
 *
 * @param {string} group
 * @param {string} name
 */
function guessUnit(group, name) {
    if (group === 'day' || group === 'total') {
        if (/^(autarky_rate|own_consumption)_/.test(name)) {
            return '%';
        }
        return /_(day|total)$/.test(name) ? 'kWh' : null;
    }
    if (!group.startsWith('now-')) {
        return null;
    }
    if (/voltage|_v_m(ax|in)$/.test(name)) {
        return 'V';
    }
    if (/current/.test(name)) {
        return 'A';
    }
    if (/fr?equency/.test(name)) {
        return 'Hz';
    }
    if (/temp|_t_m(ax|in)$/.test(name)) {
        return '°C';
    }
    if (/^battery_so[ch]$/.test(name)) {
        return '%';
    }
    if (/^(backup|consumption|inverter|grid|pv)(_[a-c12])?$/.test(name)) {
        return 'W';
    }
    if (name === 'pv_generation_duration') {
        return 'h';
    }
    return null;
}

const idPart = s => s.replace(/[^A-Za-z0-9_]/g, '_');

/** Source for the Energy Butler (interface: see lib/profiles/index.js). */
class MtecmqttSource {
    /**
     * @param {object} options
     * @param {string} [options.prefix] MTECmqtt's MQTT_TOPIC (default MTEC)
     * @param {string} [options.serial] serial number; empty = take the first one seen
     * @param {number} options.staleMs main group (`now-base`) counts as stale from this age on
     * @param {number} options.slowStaleMs fields of the slow groups are set to null from this age on
     * @param {number} [options.quietMs] quiet period that ends a record
     * @param {number} [options.now] start time (ms)
     */
    constructor(options) {
        this.profile = 'mtecmqtt';
        this.device = 'butler';
        this.prefix =
            String(options.prefix || '')
                .trim()
                .replace(/^\/+|\/+$/g, '') || 'MTEC';
        this.fixedSerial = String(options.serial || '').trim() || null;
        this.serial = this.fixedSerial;
        this.staleMs = options.staleMs;
        this.slowStaleMs = options.slowStaleMs;
        this.quietMs = options.quietMs ?? QUIET_MS;
        this.subscriptions = [{ topic: `${this.prefix}/${this.fixedSerial || '+'}/#`, qos: 0 }];
        /** Time of the last main group record. @type {number | null} */
        this.lastTs = null;
        this.groupTs = {};
        this.expired = new Set();
        this.startTs = options.now ?? Date.now();
        this.batch = null;
        this.extraTypes = {};
    }

    get pending() {
        return this.batch !== null;
    }

    matches(topic) {
        return topic.startsWith(`${this.prefix}/`);
    }

    /**
     * @param {string} topic
     * @param {Buffer | string} payload
     * @param {number} now
     */
    handle(topic, payload, now) {
        const parts = topic.slice(this.prefix.length + 1).split('/');
        if (parts.length !== 3 || parts.some(p => !p)) {
            return [{ type: 'skipped', reason: 'unexpected topic structure' }];
        }
        const [serial, group, name] = parts;
        const out = [];
        if (this.serial === null) {
            this.serial = serial;
            out.push({ type: 'serial', serial });
        } else if (serial !== this.serial) {
            return [{ type: 'foreign', reason: `serial number ${serial}`, serial }];
        }
        if (this.batch && (now - this.batch.start > MAX_BATCH_MS || this.batch.values.get(group)?.has(name))) {
            out.push(...this.flush(now));
        }
        if (!this.batch) {
            this.batch = { start: now, values: new Map() };
        }
        if (!this.batch.values.has(group)) {
            this.batch.values.set(group, new Map());
        }
        this.batch.values.get(group).set(name, payload.toString());
        return out;
    }

    /** Processes the collected values as one record. */
    flush() {
        const batch = this.batch;
        this.batch = null;
        if (!batch) {
            return [];
        }
        const ts = batch.start;
        const updates = [];
        const rejected = [];
        const extras = [];
        const counters = {};
        const restored = [];
        for (const [group, values] of batch.values) {
            const map = FIELD_MAP[group] || {};
            const reported = new Map();
            for (const [name, raw] of values) {
                const val = parseValue(raw);
                const field = map[name];
                if (field) {
                    if (typeof val === 'number') {
                        reported.set(field, val);
                    } else {
                        rejected.push(`${group}/${name}`);
                    }
                    continue;
                }
                extras.push(this.extra(group, name, val));
                if (group === 'day' && DAY_COUNTERS[name] && typeof val === 'number') {
                    counters[DAY_COUNTERS[name]] = val;
                }
            }
            for (const [signed, pos, neg] of SPLIT) {
                if (reported.has(signed)) {
                    const v = reported.get(signed);
                    reported.set(pos, Math.max(0, v));
                    reported.set(neg, Math.max(0, -v));
                }
            }
            for (const field of groupFields(group)) {
                updates.push(
                    reported.has(field)
                        ? { field, val: reported.get(field), q: 0 }
                        : { field, val: null, q: Q_SENSOR_NOT_REPORTED },
                );
            }
            this.groupTs[group] = ts;
            if (this.expired.delete(group)) {
                restored.push(group);
            }
        }
        const main = batch.values.has(MAIN_GROUP);
        if (main) {
            this.lastTs = ts;
        }
        return [
            {
                type: 'record',
                device: this.device,
                ts,
                main,
                groups: [...batch.values.keys()],
                updates,
                unknown: [],
                rejected,
                extras,
                counters: Object.keys(counters).length ? counters : null,
                restored,
            },
        ];
    }

    /**
     * Value without a counterpart among our fields → `butler.mtecmqtt.<group>.<name>`.
     *
     * @param group
     * @param name
     * @param val
     */
    extra(group, name, val) {
        const root = `${this.device}.mtecmqtt`;
        const channel = `${root}.${idPart(group)}`;
        const id = `${channel}.${idPart(name)}`;
        // The first value decides the type; later values of another type are not forced into it.
        const type = (this.extraTypes[id] ??= typeof val === 'number' ? 'number' : 'string');
        const unit = type === 'number' ? guessUnit(group, name) : null;
        const common = {
            name: `MTECmqtt ${group}/${name}`,
            type,
            role: type === 'number' ? ROLE_BY_UNIT[unit] || 'value' : 'text',
            read: true,
            write: false,
        };
        if (unit) {
            common.unit = unit;
        }
        return {
            id,
            val: type === 'number' ? (typeof val === 'number' ? val : null) : String(val),
            common,
            channels: [
                { id: root, name: t('Further values from MTECmqtt', 'Weitere Werte von MTECmqtt') },
                { id: channel, name: group },
            ],
        };
    }

    /**
     * Sets the fields of slow groups to null that have not been seen for `slowStaleMs`
     * (counted from the start if they never came).
     *
     * @param {number} now
     */
    expire(now) {
        const updates = [];
        const groups = [];
        for (const group of SLOW_GROUPS) {
            const fields = groupFields(group);
            if (!fields.length || this.expired.has(group)) {
                continue;
            }
            if (now - (this.groupTs[group] ?? this.startTs) > this.slowStaleMs) {
                this.expired.add(group);
                groups.push(group);
                for (const field of fields) {
                    updates.push({ field, val: null, q: Q_SENSOR_NOT_REPORTED });
                }
            }
        }
        return groups.length ? [{ type: 'expired', device: this.device, ts: now, groups, updates }] : [];
    }

    /** @param {number} now */
    isStale(now) {
        return this.lastTs === null || now - this.lastTs > this.staleMs;
    }
}

module.exports = {
    MtecmqttSource,
    FIELD_MAP,
    DAY_COUNTERS,
    MAIN_GROUP,
    SLOW_GROUPS,
    QUIET_MS,
    groupFields,
    guessUnit,
    parseValue,
};
