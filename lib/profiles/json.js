'use strict';

/**
 * Input profile `json`: one topic per device, each message a JSON object with `fields` (values)
 * and `timestamp` (time of measurement, Unix time in ms). Format: docs/profile-json.md
 *
 * Rules:
 * - Duplicates (QoS 1) and older messages are detected by `timestamp` and discarded.
 * - A missing known field is not 0; it is set to null with q = 0x82.
 * - 0 is a valid value.
 * - Whether data is stale depends on the age of the last measurement, not on the time of receipt.
 */

/** ioBroker quality: the sensor reported no value. */
const Q_SENSOR_NOT_REPORTED = 0x82;

/** Timestamps further than this in the future are rejected (clock error). */
const MAX_FUTURE_MS = 60_000;

/**
 * Removes floating point noise from scaling at the source (31.400000000000002 → 31.4)
 * without losing real decimals.
 *
 * @param {number} v
 */
function clean(v) {
    return Number.isInteger(v) ? v : parseFloat(v.toPrecision(12));
}

/** Processes the messages of one device, without ioBroker or MQTT dependencies. */
class DeviceTelemetry {
    /**
     * @param {Record<string, object>} knownFields field definitions of the device
     * @param {number} staleMs the last measurement counts as stale from this age on
     */
    constructor(knownFields, staleMs) {
        this.knownFields = knownFields;
        this.staleMs = staleMs;
        /** @type {number | null} */
        this.lastTs = null;
    }

    /**
     * @param {Buffer | string} payload raw MQTT payload
     * @param {number} now current time in ms
     * @returns {{status: 'ok', ts: number, updates: Array<{field: string, val: number | boolean | null, q: number}>, unknown: string[], rejected: string[]}
     *   | {status: 'invalid', reason: string}
     *   | {status: 'duplicate' | 'outdated', ts: number}}
     */
    process(payload, now) {
        let msg;
        try {
            msg = JSON.parse(payload.toString());
        } catch {
            return { status: 'invalid', reason: 'not valid JSON' };
        }
        if (!msg || typeof msg !== 'object' || !msg.fields || typeof msg.fields !== 'object' || Array.isArray(msg.fields)) {
            return { status: 'invalid', reason: 'object "fields" is missing' };
        }
        const ts = msg.timestamp;
        if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
            return { status: 'invalid', reason: '"timestamp" is missing or not a number' };
        }
        if (ts > now + MAX_FUTURE_MS) {
            return { status: 'invalid', reason: `"timestamp" is ${Math.round((ts - now) / 1000)} s in the future` };
        }
        if (this.lastTs !== null && ts <= this.lastTs) {
            return { status: ts === this.lastTs ? 'duplicate' : 'outdated', ts };
        }
        this.lastTs = ts;

        const updates = [];
        const unknown = [];
        const rejected = [];

        const reported = new Set();
        for (const [field, raw] of Object.entries(msg.fields)) {
            const def = this.knownFields[field];
            if (typeof raw !== 'number' || !Number.isFinite(raw)) {
                rejected.push(field);
                continue;
            }
            if (!def) {
                unknown.push(field);
            }
            reported.add(field);
            updates.push({ field, val: def && def.bool ? raw !== 0 : clean(raw), q: 0 });
        }
        // Missing or unusable values of known fields: null instead of the old value or 0.
        for (const field of Object.keys(this.knownFields)) {
            if (!reported.has(field)) {
                updates.push({ field, val: null, q: Q_SENSOR_NOT_REPORTED });
            }
        }
        return { status: 'ok', ts, updates, unknown, rejected };
    }

    /**
     * @param {number} now current time in ms
     */
    isStale(now) {
        return this.lastTs === null || now - this.lastTs > this.staleMs;
    }
}

/** Source for one device on one topic (interface: see lib/profiles/index.js). */
class JsonSource {
    /**
     * @param {string} device device ID (`heatpump` or `butler`)
     * @param {string} topic MQTT topic
     * @param {Record<string, object>} knownFields field definitions of the device
     * @param {number} staleMs
     */
    constructor(device, topic, knownFields, staleMs) {
        this.profile = 'json';
        this.device = device;
        this.topic = topic;
        this.staleMs = staleMs;
        this.telemetry = new DeviceTelemetry(knownFields, staleMs);
        this.subscriptions = [{ topic, qos: 1 }];
        this.pending = false;
        this.quietMs = 0;
    }

    get lastTs() {
        return this.telemetry.lastTs;
    }

    matches(topic) {
        return topic === this.topic;
    }

    handle(topic, payload, now) {
        const r = this.telemetry.process(payload, now);
        if (r.status === 'invalid') {
            return [{ type: 'invalid', reason: r.reason }];
        }
        if (r.status !== 'ok') {
            return [{ type: 'skipped', reason: `${r.status === 'duplicate' ? 'duplicate' : 'older message'} (${r.ts})` }];
        }
        return [{ type: 'record', device: this.device, ts: r.ts, main: true, updates: r.updates, unknown: r.unknown, rejected: r.rejected }];
    }

    flush() {
        return [];
    }

    expire() {
        return [];
    }

    isStale(now) {
        return this.telemetry.isStale(now);
    }
}

module.exports = { DeviceTelemetry, JsonSource, Q_SENSOR_NOT_REPORTED, clean };
