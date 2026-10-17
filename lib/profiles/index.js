'use strict';

/**
 * Input profiles: each one turns the MQTT messages of a data source into records with our field
 * names. Telemetry rules, data points and analysis are the same for all of them.
 *
 * A source has:
 * - `profile`, `device` ('heatpump' | 'butler'), `subscriptions` ([{topic, qos}])
 * - `matches(topic)`, `handle(topic, payload, now)` → results
 * - `pending`, `quietMs`, `flush(now)` → results: for sources that collect several messages into
 *   one record; the bridge calls `flush` once the topics have been quiet for `quietMs`
 * - `expire(now)` → results, `isStale(now)`, `lastTs` (time of the last main record)
 *
 * Results:
 * - `{type: 'record', device, ts, main, updates: [{field, val, q}], unknown, rejected, extras?, counters?, restored?}`
 *   `main`: contains the device's main values (sets lastMeasurement and stale, feeds the analysis)
 * - `{type: 'expired', device, ts, groups, updates}`: values of a slow group are outdated
 * - `{type: 'invalid', reason}`, `{type: 'skipped', reason}`, `{type: 'foreign', reason}`, `{type: 'serial', serial}`
 */

const { DEVICES } = require('../fields');
const { JsonSource } = require('./json');
const { MtecmqttSource } = require('./mtecmqtt');

const PROFILES = ['json', 'mtecmqtt'];

/** @param {object} config */
function profileOf(config) {
    return config.profile ? String(config.profile) : 'json';
}

/**
 * Creates the sources for the adapter configuration. The heat pump is always read via `json`.
 *
 * @param {object} config adapter configuration (native)
 * @param {object} [options]
 * @param {number} [options.mtecQuietMs] quiet period for MTECmqtt (tests)
 * @param {number} [options.now] start time (tests)
 */
function createSources(config, options = {}) {
    const staleMs = Math.max(1, Number(config.staleSeconds) || 20) * 1000;
    const topicHeatpump = String(config.topicHeatpump || '').trim();
    const topicButler = String(config.topicButler || '').trim();
    const sources = [];
    if (topicHeatpump) {
        sources.push(new JsonSource('heatpump', topicHeatpump, DEVICES.heatpump.fields, staleMs));
    }
    if (profileOf(config) === 'mtecmqtt') {
        sources.push(new MtecmqttSource({
            prefix: config.mtecTopicPrefix,
            serial: config.mtecSerial,
            staleMs,
            slowStaleMs: Math.max(1, Number(config.staleSecondsSlow) || 180) * 1000,
            quietMs: options.mtecQuietMs,
            now: options.now,
        }));
    } else if (topicButler) {
        sources.push(new JsonSource('butler', topicButler, DEVICES.butler.fields, staleMs));
    }
    return sources;
}

module.exports = { PROFILES, createSources, profileOf };
