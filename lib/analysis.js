'use strict';

/**
 * Analysis of the live values, without ioBroker dependencies:
 * house consumption, self-sufficiency, battery forecast, PV surplus, cost/savings and daily values.
 *
 * Daily values are estimated from the power (power × time since the previous measurement).
 * Where the source delivers daily energy counters (profile `mtecmqtt`), each counter reading
 * replaces the estimate; between readings the estimate continues from there.
 */

const { t } = require('./fields');

/** Longer gaps between two measurements are not extrapolated. */
const MAX_GAP_MS = 60_000;
/** Period for moving averages (battery forecast, surplus). */
const AVG_WINDOW_MS = 5 * 60_000;
/** Below this the battery counts as idle. */
const MIN_FLOW_W = 50;
/** Heat pump values count as current for "house consumption without heat pump" for this long. */
const HEATPUMP_FRESH_MS = 30_000;
/** Shortly after midnight the source may still report yesterday's counters. */
const COUNTER_GRACE_MS = 30 * 60_000;

const TODAY_KEYS = [
    'pv_kwh',
    'grid_import_kwh',
    'grid_export_kwh',
    'battery_charge_kwh',
    'battery_discharge_kwh',
    'house_kwh',
    'heatpump_electrical_kwh',
    'heatpump_thermal_kwh',
    'cost',
    'savings',
];

/** Daily values that a source can deliver as counters. */
const COUNTER_KEYS = ['pv_kwh', 'grid_import_kwh', 'grid_export_kwh', 'battery_charge_kwh', 'battery_discharge_kwh'];

/** Data points of the analysis (without the prefix "analysis."). `€` is replaced by the configured currency. */
const ANALYSIS_STATES = {
    house_power_w: { name: t('House consumption', 'Hausverbrauch'), type: 'number', role: 'value.power', unit: 'W' },
    house_without_heatpump_w: {
        name: t('House consumption without heat pump', 'Hausverbrauch ohne Wärmepumpe'),
        type: 'number',
        role: 'value.power',
        unit: 'W',
    },
    autarky_percent: { name: t('Self-sufficiency now', 'Autarkie jetzt'), type: 'number', role: 'value', unit: '%' },
    self_consumption_percent: {
        name: t('PV self-consumption now', 'Eigenverbrauch der PV jetzt'),
        type: 'number',
        role: 'value',
        unit: '%',
    },
    surplus_w: {
        name: t('PV surplus (5 min average)', 'PV-Überschuss (Mittel 5 min)'),
        type: 'number',
        role: 'value.power',
        unit: 'W',
    },
    surplus_available: { name: t('Solar power to spare', 'Sonnenstrom übrig'), type: 'boolean', role: 'indicator' },
    battery_energy_kwh: {
        name: t('Energy in the battery', 'Energie im Akku'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    battery_full_in_min: { name: t('Battery full in', 'Akku voll in'), type: 'number', role: 'value', unit: 'min' },
    battery_empty_in_min: {
        name: t('Battery lasts for', 'Akku reicht noch'),
        type: 'number',
        role: 'value',
        unit: 'min',
    },
    battery_status_text: { name: t('Battery forecast', 'Akku-Prognose'), type: 'string', role: 'text' },
    cost_now_per_h: {
        name: t('Electricity cost now', 'Stromkosten jetzt'),
        type: 'number',
        role: 'value',
        unit: '€/h',
    },
    savings_now_per_h: { name: t('Savings now', 'Ersparnis jetzt'), type: 'number', role: 'value', unit: '€/h' },
    grid_balance_per_h: {
        name: t(
            'Grid balance now (+ feed-in revenue, − import cost)',
            'Netz-Bilanz jetzt (+ Einspeiseerlös, − Bezugskosten)',
        ),
        type: 'number',
        role: 'value',
        unit: '€/h',
    },
    grid_balance_text: {
        name: t('Grid balance now as text, e.g. "+0.27 €/h"', 'Netz-Bilanz jetzt als Text, z. B. "+0,27 €/h"'),
        type: 'string',
        role: 'text',
    },
    'today.date': { name: t('Day of the daily values', 'Tag der Tageswerte'), type: 'string', role: 'text' },
    'today.pv_kwh': { name: t('PV yield today', 'PV-Ertrag heute'), type: 'number', role: 'value.energy', unit: 'kWh' },
    'today.grid_import_kwh': {
        name: t('Grid import today', 'Netzbezug heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.grid_export_kwh': {
        name: t('Grid export today', 'Einspeisung heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.battery_charge_kwh': {
        name: t('Battery charged today', 'Akku geladen heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.battery_discharge_kwh': {
        name: t('Battery discharged today', 'Akku entladen heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.house_kwh': {
        name: t('House consumption today', 'Hausverbrauch heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.heatpump_electrical_kwh': {
        name: t('Heat pump electricity today', 'Wärmepumpe Strom heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.heatpump_thermal_kwh': {
        name: t('Heat pump heat today', 'Wärmepumpe Wärme heute'),
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
    },
    'today.heatpump_cop': { name: t('Heat pump COP today', 'Wärmepumpe COP heute'), type: 'number', role: 'value' },
    'today.autarky_percent': {
        name: t('Self-sufficiency today', 'Autarkie heute'),
        type: 'number',
        role: 'value',
        unit: '%',
    },
    'today.cost': { name: t('Electricity cost today', 'Stromkosten heute'), type: 'number', role: 'value', unit: '€' },
    'today.savings': { name: t('Savings today', 'Ersparnis heute'), type: 'number', role: 'value', unit: '€' },
};

/** Texts of the text data points; the system language decides (German or English). */
const TEXTS = {
    en: {
        full: 'full',
        fullIn: (d, c) => `full in ${d} (approx. ${c})`,
        lasts: (d, c) => `lasts ${d} (until approx. ${c})`,
        empty: 'empty (minimum charge level)',
        idle: 'idle',
        decimal: '.',
    },
    de: {
        full: 'voll',
        fullIn: (d, c) => `voll in ${d} (ca. ${c} Uhr)`,
        lasts: (d, c) => `reicht noch ${d} (bis ca. ${c} Uhr)`,
        empty: 'leer (Mindestladestand)',
        idle: 'ruht',
        decimal: ',',
    },
};

const round = (v, digits) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Local date (time zone of the host) as YYYY-MM-DD.
 *
 * @param {number} ts
 */
function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @param {number} ts */
function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** @param {number} ts */
function clockTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Amount with sign, e.g. "+0.27 €" / "−0.86 €" / "±0.00 €" (German: decimal comma).
 *
 * @param {number} v
 * @param {string} currency
 * @param {string} [language] 'de' or 'en' (default)
 */
function money(v, currency, language) {
    const sign = v >= 0.005 ? '+' : v <= -0.005 ? '−' : '±';
    const decimal = (TEXTS[language] || TEXTS.en).decimal;
    return `${sign}${Math.abs(v).toFixed(2).replace('.', decimal)} ${currency}`;
}

/** @param {number} min */
function duration(min) {
    if (min < 60) {
        return `${min} min`;
    }
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

/** Calculates the analysis values; one instance per adapter instance. */
class Analysis {
    /**
     * @param {object} options
     * @param {number} options.capacityKwh usable battery capacity
     * @param {number} options.minSocPercent state of charge down to which the battery discharges
     * @param {number | null} options.priceImport grid import price per kWh (null = not set)
     * @param {number | null} options.priceExport feed-in tariff per kWh (null = not set)
     * @param {number} options.surplusThresholdW "solar power to spare" from this average surplus on
     * @param {string} [options.currency] currency symbol for texts (default €)
     * @param {string} [options.language] language of the texts: 'de' or 'en' (default)
     */
    constructor(options) {
        this.o = options;
        this.texts = TEXTS[options.language] || TEXTS.en;
        this.day = null;
        this.today = Object.fromEntries(TODAY_KEYS.map(k => [k, 0]));
        this.lastButler = null; // { ts, pv, imp, exp, chg, dis, house, self }
        this.lastHeatpump = null; // { ts, el, th }
        this.samples = []; // { ts, chg, dis, surplus }
        this.surplusOn = false;
        /** Last accepted counter reading per key. @type {Record<string, {day: string, val: number}>} */
        this.counterRef = {};
    }

    /**
     * Takes over stored daily values after a restart if they are from the same day.
     *
     * @param {string | null} day
     * @param {Record<string, number | null>} values
     * @param {number} now
     */
    restore(day, values, now) {
        if (day && day === dayKey(now)) {
            this.day = day;
            for (const k of TODAY_KEYS) {
                const v = num(values[k]);
                if (v !== null) {
                    this.today[k] = v;
                }
            }
            return true;
        }
        return false;
    }

    /**
     * Resets the daily values when a new day (local time) has started.
     *
     * @param {number} ts time of the current measurement
     */
    rollDay(ts) {
        const key = dayKey(ts);
        if (this.day !== key) {
            const changed = this.day !== null;
            this.day = key;
            for (const k of TODAY_KEYS) {
                this.today[k] = 0;
            }
            if (changed) {
                // Do not extrapolate across midnight.
                this.lastButler = null;
                this.lastHeatpump = null;
            }
        }
    }

    /**
     * New heat pump measurement.
     *
     * @param {Record<string, any>} f fields of the message
     * @param {number} ts time of measurement
     */
    heatpump(f, ts) {
        this.rollDay(ts);
        const el = num(f.electrical_power_w);
        const th = num(f.thermal_power_w);
        const prev = this.lastHeatpump;
        if (prev && ts > prev.ts && ts - prev.ts <= MAX_GAP_MS) {
            const h = (ts - prev.ts) / 3_600_000;
            if (prev.el !== null) {
                this.today.heatpump_electrical_kwh += (prev.el / 1000) * h;
            }
            if (prev.th !== null) {
                this.today.heatpump_thermal_kwh += (prev.th / 1000) * h;
            }
        }
        this.lastHeatpump = { ts, el, th };
        return this.todayValues();
    }

    /**
     * New Energy Butler measurement.
     *
     * @param {Record<string, any>} f fields of the message
     * @param {number} ts time of measurement
     */
    butler(f, ts) {
        this.rollDay(ts);
        const pv = num(f.pv_total_power_w);
        const imp = num(f.grid_import_power_w);
        const exp = num(f.grid_export_power_w);
        const chg = num(f.battery_charge_power_w);
        const dis = num(f.battery_discharge_power_w);
        const soc = num(f.battery_soc_percent);
        const complete = pv !== null && imp !== null && exp !== null && chg !== null && dis !== null;

        const now = {};
        let house = null;
        let self = null;
        if (complete) {
            house = Math.max(0, pv + imp + dis - exp - chg);
            self = Math.max(0, house - imp); // covered by PV and battery
            now.house_power_w = round(house, 0);
            const hp = this.lastHeatpump;
            now.house_without_heatpump_w =
                hp && hp.el !== null && Math.abs(ts - hp.ts) <= HEATPUMP_FRESH_MS
                    ? round(Math.max(0, house - hp.el), 0)
                    : null;
            now.autarky_percent = house > 0 ? round(clamp(100 * (1 - imp / house), 0, 100), 1) : null;
            now.self_consumption_percent = pv > 0 ? round(clamp((100 * (pv - exp)) / pv, 0, 100), 1) : null;

            // Moving averages
            this.samples.push({ ts, chg, dis, surplus: Math.max(0, pv - house) });
            this.samples = this.samples.filter(s => ts - s.ts <= AVG_WINDOW_MS);
            const avg = key => this.samples.reduce((a, s) => a + s[key], 0) / this.samples.length;
            const avgSurplus = avg('surplus');
            now.surplus_w = round(avgSurplus, 0);
            const thr = this.o.surplusThresholdW;
            this.surplusOn = this.surplusOn ? avgSurplus >= thr * 0.7 : avgSurplus >= thr;
            now.surplus_available = this.surplusOn;

            // Battery forecast
            const avgChg = avg('chg');
            const avgDis = avg('dis');
            const cap = this.o.capacityKwh;
            now.battery_full_in_min = null;
            now.battery_empty_in_min = null;
            if (soc !== null && cap > 0) {
                if (avgChg > MIN_FLOW_W && soc < 99.5) {
                    now.battery_full_in_min = Math.round(((((100 - soc) / 100) * cap * 1000) / avgChg) * 60);
                } else if (avgDis > MIN_FLOW_W && soc > this.o.minSocPercent) {
                    now.battery_empty_in_min = Math.round(
                        ((((soc - this.o.minSocPercent) / 100) * cap * 1000) / avgDis) * 60,
                    );
                }
            }
            now.battery_status_text = this.batteryText(soc, now.battery_full_in_min, now.battery_empty_in_min, ts);

            // Cost/savings now
            const pi = this.o.priceImport;
            const pe = this.o.priceExport || 0;
            now.cost_now_per_h = pi !== null ? round((imp / 1000) * pi, 2) : null;
            now.savings_now_per_h = pi !== null ? round((self / 1000) * pi + (exp / 1000) * pe, 2) : null;
            const balance = pi !== null ? (exp / 1000) * pe - (imp / 1000) * pi : null;
            now.grid_balance_per_h = balance !== null ? round(balance, 2) : null;
            now.grid_balance_text =
                balance !== null ? `${money(balance, this.o.currency || '€', this.o.language)}/h` : null;
        } else {
            for (const k of [
                'house_power_w',
                'house_without_heatpump_w',
                'autarky_percent',
                'self_consumption_percent',
                'battery_full_in_min',
                'battery_empty_in_min',
                'cost_now_per_h',
                'savings_now_per_h',
                'grid_balance_per_h',
                'grid_balance_text',
            ]) {
                now[k] = null;
            }
            now.battery_status_text = null;
        }
        now.battery_energy_kwh =
            soc !== null && this.o.capacityKwh > 0 ? round((soc / 100) * this.o.capacityKwh, 2) : null;

        // Daily values: power since the previous measurement × time
        const prev = this.lastButler;
        if (prev && ts > prev.ts && ts - prev.ts <= MAX_GAP_MS) {
            const h = (ts - prev.ts) / 3_600_000;
            const kwh = w => (w / 1000) * h;
            this.today.pv_kwh += kwh(prev.pv);
            this.today.grid_import_kwh += kwh(prev.imp);
            this.today.grid_export_kwh += kwh(prev.exp);
            this.today.battery_charge_kwh += kwh(prev.chg);
            this.today.battery_discharge_kwh += kwh(prev.dis);
            this.today.house_kwh += kwh(prev.house);
            if (this.o.priceImport !== null) {
                this.today.cost += kwh(prev.imp) * this.o.priceImport;
                this.today.savings += kwh(prev.self) * this.o.priceImport + kwh(prev.exp) * (this.o.priceExport || 0);
            }
        }
        this.lastButler = complete ? { ts, pv, imp, exp, chg, dis, house, self } : null;

        return { now, today: this.todayValues() };
    }

    /**
     * Daily energy counters of the source (kWh since midnight, keys from COUNTER_KEYS).
     * Each reading replaces the estimated value; with all five counters, house consumption,
     * cost and savings are recalculated from them as well.
     *
     * @param {Record<string, number>} values
     * @param {number} ts time of the reading
     */
    counters(values, ts) {
        this.rollDay(ts);
        const inGrace = ts - startOfDay(ts) < COUNTER_GRACE_MS;
        /** @type {Record<string, number>} */
        const accepted = {};
        for (const k of COUNTER_KEYS) {
            const v = num(values[k]);
            if (v === null || v < 0) {
                continue;
            }
            const ref = this.counterRef[k];
            if (inGrace && !(ref && ref.day === this.day)) {
                // Right after midnight, accept only a value that has visibly been reset;
                // without yesterday's reading (restart) wait for the end of the grace period.
                if (!ref || (ref.val > 0 && v >= ref.val)) {
                    continue;
                }
            }
            accepted[k] = v;
            this.today[k] = v;
            this.counterRef[k] = { day: this.day, val: v };
        }
        if (COUNTER_KEYS.every(k => k in accepted)) {
            const {
                pv_kwh: pv,
                grid_import_kwh: imp,
                grid_export_kwh: exp,
                battery_charge_kwh: chg,
                battery_discharge_kwh: dis,
            } = accepted;
            const house = Math.max(0, pv + imp + dis - exp - chg);
            this.today.house_kwh = house;
            if (this.o.priceImport !== null) {
                this.today.cost = imp * this.o.priceImport;
                this.today.savings = Math.max(0, house - imp) * this.o.priceImport + exp * (this.o.priceExport || 0);
            }
            // The counters contain everything up to now: continue the estimate from here.
            if (this.lastButler && ts > this.lastButler.ts) {
                this.lastButler = { ...this.lastButler, ts };
            }
        } else if ('grid_import_kwh' in accepted && this.o.priceImport !== null) {
            this.today.cost = accepted.grid_import_kwh * this.o.priceImport;
        }
        return this.todayValues();
    }

    /**
     * Battery forecast as text in the configured language.
     *
     * @param {number | null} soc state of charge in %
     * @param {number | null} fullIn minutes until full
     * @param {number | null} emptyIn minutes until the minimum state of charge
     * @param {number} ts time of the measurement
     */
    batteryText(soc, fullIn, emptyIn, ts) {
        const tx = this.texts;
        if (soc === null) {
            return null;
        }
        if (soc >= 99.5) {
            return tx.full;
        }
        if (fullIn !== null) {
            return tx.fullIn(duration(fullIn), clockTime(ts + fullIn * 60_000));
        }
        if (emptyIn !== null) {
            return tx.lasts(duration(emptyIn), clockTime(ts + emptyIn * 60_000));
        }
        if (soc <= this.o.minSocPercent + 0.5) {
            return tx.empty;
        }
        return tx.idle;
    }

    /** Daily values as data point values (`today.*`), rounded. */
    todayValues() {
        const td = this.today;
        const priced = this.o.priceImport !== null;
        return {
            'today.date': this.day,
            'today.pv_kwh': round(td.pv_kwh, 2),
            'today.grid_import_kwh': round(td.grid_import_kwh, 2),
            'today.grid_export_kwh': round(td.grid_export_kwh, 2),
            'today.battery_charge_kwh': round(td.battery_charge_kwh, 2),
            'today.battery_discharge_kwh': round(td.battery_discharge_kwh, 2),
            'today.house_kwh': round(td.house_kwh, 2),
            'today.heatpump_electrical_kwh': round(td.heatpump_electrical_kwh, 2),
            'today.heatpump_thermal_kwh': round(td.heatpump_thermal_kwh, 2),
            'today.heatpump_cop':
                td.heatpump_electrical_kwh >= 0.05
                    ? round(td.heatpump_thermal_kwh / td.heatpump_electrical_kwh, 2)
                    : null,
            'today.autarky_percent':
                td.house_kwh >= 0.05 ? round(clamp(100 * (1 - td.grid_import_kwh / td.house_kwh), 0, 100), 1) : null,
            'today.cost': priced ? round(td.cost, 2) : null,
            'today.savings': priced ? round(td.savings, 2) : null,
        };
    }
}

/**
 * Reads the analysis settings from the adapter configuration.
 * Prices in cents per kWh; 0 or empty = not set. Values below 1 are read as currency units per kWh
 * (e.g. 0.26 instead of 26) – nobody pays less than 1 cent per kWh.
 *
 * @param {object} config
 */
function analysisOptions(config) {
    const ct = v => {
        const n = Number(v);
        if (!(n > 0)) {
            return null;
        }
        return n < 1 ? n : n / 100;
    };
    return {
        capacityKwh: Number(config.batteryCapacityKwh) > 0 ? Number(config.batteryCapacityKwh) : 0,
        minSocPercent: Number.isFinite(Number(config.batteryMinSoc)) ? Number(config.batteryMinSoc) : 10,
        priceImport: ct(config.priceImportCt),
        priceExport: ct(config.priceExportCt),
        surplusThresholdW: Number(config.surplusThresholdW) > 0 ? Number(config.surplusThresholdW) : 1000,
        currency: String(config.currency || '').trim() || '€',
        language: config.language === 'de' ? 'de' : 'en',
    };
}

/**
 * Data point definitions with the configured currency as unit.
 *
 * @param {string} [currency] default €
 */
function analysisStates(currency) {
    const cur = currency || '€';
    return Object.fromEntries(
        Object.entries(ANALYSIS_STATES).map(([k, def]) => {
            /** @type {{ name: Record<string, string>, type: string, role: string, unit?: string }} */
            const d = { ...def };
            if (d.unit === '€/h') {
                d.unit = `${cur}/h`;
            } else if (d.unit === '€') {
                d.unit = cur;
            }
            d.name = Object.fromEntries(Object.entries(d.name).map(([lang, s]) => [lang, s.replace(/€/g, cur)]));
            return [k, d];
        }),
    );
}

module.exports = {
    Analysis,
    ANALYSIS_STATES,
    COUNTER_KEYS,
    TODAY_KEYS,
    analysisOptions,
    analysisStates,
    dayKey,
    money,
};
