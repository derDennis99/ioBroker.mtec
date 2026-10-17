import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Analysis, analysisOptions, analysisStates, dayKey, money } = require('../lib/analysis.js');

const T0 = new Date(2026, 9, 17, 12, 0, 0).getTime(); // 17 Oct 2026 12:00 local time
const opts = (o = {}) => ({
    capacityKwh: 15,
    minSocPercent: 10,
    priceImport: null,
    priceExport: null,
    surplusThresholdW: 1000,
    ...o,
});
const butler = (pv, imp, exp, chg, dis, soc = 50) => ({
    pv_total_power_w: pv,
    grid_import_power_w: imp,
    grid_export_power_w: exp,
    battery_charge_power_w: chg,
    battery_discharge_power_w: dis,
    battery_soc_percent: soc,
});

test('house consumption while the battery charges from the grid (real values of 17 Oct)', () => {
    const a = new Analysis(opts());
    const { now } = a.butler(butler(450, 4200, 0, 980, 0, 38.4), T0);
    assert.equal(now.house_power_w, 3670);
    assert.equal(now.autarky_percent, 0, 'import larger than consumption → 0 %');
    assert.equal(now.surplus_w, 0);
    assert.equal(now.surplus_available, false);
    assert.equal(now.battery_energy_kwh, 5.76);
});

test('sunny noon: self-sufficiency, self-consumption, surplus', () => {
    const a = new Analysis(opts());
    const { now } = a.butler(butler(5000, 0, 1500, 2000, 0), T0);
    assert.equal(now.house_power_w, 1500);
    assert.equal(now.autarky_percent, 100);
    assert.equal(now.self_consumption_percent, 70);
    assert.equal(now.surplus_w, 3500);
    assert.equal(now.surplus_available, true);
});

test('the surplus indicator has a hysteresis', () => {
    const a = new Analysis(opts());
    let t = T0;
    a.butler(butler(2500, 0, 0, 1300, 0), t); // surplus 1300 → on
    assert.equal(a.surplusOn, true);
    // average drops to ~900 W: stays on (switch-off threshold 700 W)
    for (let i = 0; i < 60; i++) {
        a.butler(butler(2100, 0, 0, 900, 0), (t += 5000));
    }
    assert.equal(a.surplusOn, true);
    // average drops clearly below 700 W: off
    for (let i = 0; i < 70; i++) {
        a.butler(butler(1500, 0, 0, 300, 0), (t += 5000));
    }
    assert.equal(a.surplusOn, false);
});

test('battery full in / lasts for (German texts)', () => {
    const a = new Analysis(opts({ language: 'de' }));
    let r = a.butler(butler(5000, 0, 0, 2000, 0, 50), T0);
    assert.equal(r.now.battery_full_in_min, 225); // 7.5 kWh / 2 kW
    assert.equal(r.now.battery_empty_in_min, null);
    assert.equal(r.now.battery_status_text, 'voll in 3 h 45 min (ca. 15:45 Uhr)');

    const b = new Analysis(opts({ language: 'de' }));
    r = b.butler(butler(0, 0, 0, 0, 1000, 40), T0);
    assert.equal(r.now.battery_empty_in_min, 270); // (40−10) % of 15 kWh = 4.5 kWh / 1 kW
    assert.equal(r.now.battery_status_text, 'reicht noch 4 h 30 min (bis ca. 16:30 Uhr)');

    const c = new Analysis(opts({ language: 'de' }));
    assert.equal(c.butler(butler(0, 300, 0, 0, 0, 10), T0).now.battery_status_text, 'leer (Mindestladestand)');
    assert.equal(c.butler(butler(0, 300, 0, 0, 0, 100), T0 + 5000).now.battery_status_text, 'voll');
    assert.equal(c.butler(butler(0, 300, 0, 20, 0, 60), T0 + 10000).now.battery_status_text, 'ruht');
});

test('daily values: power × time, gaps over 60 s are not extrapolated', () => {
    const a = new Analysis(opts({ priceImport: 0.3, priceExport: 0.08 }));
    a.butler(butler(1000, 2000, 0, 0, 0), T0);
    const r1 = a.butler(butler(1000, 2000, 0, 0, 0), T0 + 36_000); // 36 s = 0,01 h
    assert.equal(r1.today['today.pv_kwh'], 0.01);
    assert.equal(r1.today['today.grid_import_kwh'], 0.02);
    assert.equal(r1.today['today.house_kwh'], 0.03);
    assert.equal(r1.today['today.cost'], 0.01); // 0.02 kWh × 0.30 €
    assert.equal(r1.today['today.autarky_percent'], null, 'no daily self-sufficiency below 0.05 kWh');
    const r2 = a.butler(butler(1000, 2000, 0, 0, 0), T0 + 36_000 + 120_000); // gap of 2 min
    assert.equal(r2.today['today.pv_kwh'], 0.01, 'the gap is not extrapolated');
});

test('cost and savings now', () => {
    const none = new Analysis(opts());
    assert.equal(none.butler(butler(3000, 1000, 500, 0, 0), T0).now.cost_now_per_h, null, 'no cost without a price');
    const a = new Analysis(opts({ priceImport: 0.3, priceExport: 0.08 }));
    const { now } = a.butler(butler(3000, 1000, 500, 0, 0), T0);
    // house 3500 W, 2500 W of it covered by PV and battery, 500 W exported
    assert.equal(now.cost_now_per_h, 0.3);
    assert.equal(now.savings_now_per_h, 0.79); // 2.5 kW × 0.30 + 0.5 kW × 0.08
});

test('heat pump: daily COP and house consumption without heat pump', () => {
    const a = new Analysis(opts());
    a.heatpump({ electrical_power_w: 1000, thermal_power_w: 3500 }, T0);
    const t = a.heatpump({ electrical_power_w: 1000, thermal_power_w: 3500 }, T0 + 180_000 - 120_000); // 60 s
    assert.equal(t['today.heatpump_electrical_kwh'], 0.02);
    for (let i = 1; i <= 3; i++) {
        a.heatpump({ electrical_power_w: 1000, thermal_power_w: 3500 }, T0 + 60_000 * (1 + i));
    }
    const r = a.butler(butler(0, 2500, 0, 0, 0), T0 + 240_000);
    assert.equal(r.now.house_without_heatpump_w, 1500);
    assert.equal(r.today['today.heatpump_cop'], 3.5);
});

test('a new day resets, a restart takes over values of the same day', () => {
    const a = new Analysis(opts());
    a.butler(butler(1000, 0, 0, 0, 0), T0);
    a.butler(butler(1000, 0, 0, 0, 0), T0 + 36_000);
    assert.equal(a.todayValues()['today.pv_kwh'], 0.01);
    const tomorrow = new Date(2026, 9, 18, 0, 0, 10).getTime();
    const r = a.butler(butler(0, 0, 0, 0, 0), tomorrow);
    assert.equal(r.today['today.pv_kwh'], 0);
    assert.equal(r.today['today.date'], '2026-10-18');

    const b = new Analysis(opts());
    assert.equal(b.restore(dayKey(T0), { pv_kwh: 4.2, house_kwh: 9 }, T0 + 1000), true);
    assert.equal(b.todayValues()['today.pv_kwh'], 4.2);
    const c = new Analysis(opts());
    assert.equal(c.restore('2026-10-16', { pv_kwh: 4.2 }, T0), false, 'values of yesterday are not taken over');
});

test('incomplete message: no calculated values, no extrapolation', () => {
    const a = new Analysis(opts());
    const r = a.butler({ battery_soc_percent: 50 }, T0);
    assert.equal(r.now.house_power_w, null);
    assert.equal(r.now.battery_energy_kwh, 7.5);
    assert.equal(a.lastButler, null);
});

test('settings: prices in cents, 0 = not set', () => {
    assert.deepEqual(
        analysisOptions({ batteryCapacityKwh: 15, batteryMinSoc: 10, priceImportCt: 32.5, priceExportCt: 0 }),
        {
            capacityKwh: 15,
            minSocPercent: 10,
            priceImport: 0.325,
            priceExport: null,
            surplusThresholdW: 1000,
            currency: '€',
            language: 'en',
        },
    );
    assert.equal(analysisOptions({ language: 'de' }).language, 'de');
    assert.equal(analysisOptions({ language: 'fr' }).language, 'en');
});

test('settings: prices below 1 are read as currency units', () => {
    const o = analysisOptions({ batteryCapacityKwh: 15, batteryMinSoc: 10, priceImportCt: 0.26, priceExportCt: 18 });
    assert.equal(o.priceImport, 0.26);
    assert.equal(o.priceExport, 0.18);
});

test('grid balance: + when exporting, − when importing, with currency (German)', () => {
    const a = new Analysis(opts({ priceImport: 0.26, priceExport: 0.08, currency: '€', language: 'de' }));
    let r = a.butler(butler(6000, 0, 3400, 0, 0), T0);
    assert.equal(r.now.grid_balance_per_h, 0.27);
    assert.equal(r.now.grid_balance_text, '+0,27 €/h');
    r = a.butler(butler(0, 3300, 0, 0, 0), T0 + 5000);
    assert.equal(r.now.grid_balance_per_h, -0.86);
    assert.equal(r.now.grid_balance_text, '−0,86 €/h');
    r = a.butler(butler(0, 0, 0, 0, 800), T0 + 10000);
    assert.equal(r.now.grid_balance_text, '±0,00 €/h');
    const chf = new Analysis(opts({ priceImport: 0.3, currency: 'CHF', language: 'de' }));
    assert.equal(chf.butler(butler(0, 1000, 0, 0, 0), T0).now.grid_balance_text, '−0,30 CHF/h');
    const none = new Analysis(opts());
    assert.equal(none.butler(butler(0, 1000, 0, 0, 0), T0).now.grid_balance_text, null, 'no balance without a price');
});

test('currency: units, names and default', () => {
    const d = analysisStates('CHF');
    assert.equal(d.cost_now_per_h.unit, 'CHF/h');
    assert.equal(d['today.cost'].unit, 'CHF');
    assert.deepEqual(d.grid_balance_text.name, {
        en: 'Grid balance now as text, e.g. "+0.27 CHF/h"',
        de: 'Netz-Bilanz jetzt als Text, z. B. "+0,27 CHF/h"',
    });
    assert.equal(d.house_power_w.unit, 'W');
    assert.equal(analysisOptions({}).currency, '€');
    assert.equal(analysisOptions({ currency: ' CHF ' }).currency, 'CHF');
    assert.equal(money(1.234, '€', 'de'), '+1,23 €');
    assert.equal(money(-1.234, '$'), '−1.23 $');
});

test('texts in English (default)', () => {
    const a = new Analysis(opts({ priceImport: 0.26, priceExport: 0.08 }));
    let r = a.butler(butler(5000, 0, 3400, 2000, 0, 50), T0);
    assert.equal(r.now.battery_status_text, 'full in 3 h 45 min (approx. 15:45)');
    assert.equal(r.now.grid_balance_text, '+0.27 €/h');
    r = new Analysis(opts()).butler(butler(0, 0, 0, 0, 1000, 40), T0);
    assert.equal(r.now.battery_status_text, 'lasts 4 h 30 min (until approx. 16:30)');
    const c = new Analysis(opts());
    assert.equal(c.butler(butler(0, 300, 0, 0, 0, 10), T0).now.battery_status_text, 'empty (minimum charge level)');
    assert.equal(c.butler(butler(0, 300, 0, 0, 0, 100), T0 + 5000).now.battery_status_text, 'full');
    assert.equal(c.butler(butler(0, 300, 0, 20, 0, 60), T0 + 10000).now.battery_status_text, 'idle');
});

const COUNTERS = {
    pv_kwh: 6.7,
    grid_import_kwh: 4.3,
    grid_export_kwh: 0.5,
    battery_charge_kwh: 2.1,
    battery_discharge_kwh: 1.5,
};

test('daily counters replace the estimate, the estimate continues from there', () => {
    const a = new Analysis(opts({ priceImport: 0.3, priceExport: 0.08 }));
    a.butler(butler(1000, 2000, 0, 0, 0), T0);
    a.butler(butler(1000, 2000, 0, 0, 0), T0 + 36_000);
    const t = a.counters(COUNTERS, T0 + 40_000);
    assert.equal(t['today.pv_kwh'], 6.7);
    assert.equal(t['today.grid_import_kwh'], 4.3);
    assert.equal(t['today.grid_export_kwh'], 0.5);
    assert.equal(t['today.battery_charge_kwh'], 2.1);
    assert.equal(t['today.battery_discharge_kwh'], 1.5);
    assert.equal(t['today.house_kwh'], 9.9, '6.7 + 4.3 + 1.5 − 0.5 − 2.1');
    assert.equal(t['today.cost'], 1.29, '4.3 kWh × 0.30');
    assert.equal(t['today.savings'], 1.72, '(9.9 − 4.3) kWh × 0.30 + 0.5 kWh × 0.08');
    assert.equal(t['today.autarky_percent'], 56.6);
    // the next measurement only adds the 32 s since the counter reading
    const r = a.butler(butler(1000, 2000, 0, 0, 0), T0 + 72_000);
    assert.equal(r.today['today.pv_kwh'], round2(6.7 + (1 * 32) / 3600));
    assert.equal(r.today['today.grid_import_kwh'], round2(4.3 + (2 * 32) / 3600));
});

test('daily counters: partial readings and invalid values', () => {
    const a = new Analysis(opts({ priceImport: 0.3 }));
    a.butler(butler(1000, 2000, 0, 0, 0), T0);
    a.butler(butler(1000, 2000, 0, 0, 0), T0 + 36_000);
    const t = a.counters({ grid_import_kwh: 4, pv_kwh: -1, house_kwh: 99 }, T0 + 40_000);
    assert.equal(t['today.grid_import_kwh'], 4);
    assert.equal(t['today.cost'], 1.2);
    assert.equal(t['today.pv_kwh'], 0.01, 'negative counter is ignored');
    assert.equal(t['today.house_kwh'], 0.03, 'house only from all five counters');
});

test("daily counters after midnight: yesterday's totals are not taken over", () => {
    const a = new Analysis(opts());
    a.counters(COUNTERS, new Date(2026, 9, 17, 23, 58).getTime());
    const after = new Date(2026, 9, 18, 0, 3).getTime();
    // the source has not reset yet: still yesterday's values (feed-in 0 yesterday → 0 is fine)
    let t = a.counters({ ...COUNTERS, grid_export_kwh: 0.5 }, after);
    assert.equal(t['today.date'], '2026-10-18');
    assert.equal(t['today.pv_kwh'], 0);
    assert.equal(t['today.grid_import_kwh'], 0);
    // reset values are accepted
    t = a.counters(
        { pv_kwh: 0, grid_import_kwh: 0.1, grid_export_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0.2 },
        after + 300_000,
    );
    assert.equal(t['today.grid_import_kwh'], 0.1);
    assert.equal(t['today.battery_discharge_kwh'], 0.2);
    assert.equal(t['today.house_kwh'], 0.3);
    // once accepted today, later readings count as usual
    t = a.counters({ ...COUNTERS, pv_kwh: 7 }, after + 600_000);
    assert.equal(t['today.pv_kwh'], 7);

    // after a restart shortly after midnight there is no reference: wait for the grace period
    const b = new Analysis(opts());
    assert.equal(b.counters(COUNTERS, after)['today.pv_kwh'], 0);
    assert.equal(b.counters(COUNTERS, new Date(2026, 9, 18, 0, 31).getTime())['today.pv_kwh'], 6.7);
});

const round2 = v => Number(v.toFixed(2));
