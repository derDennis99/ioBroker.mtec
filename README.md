# ioBroker.mtec

Reads an M-TEC **Energy Butler** (hybrid inverter with PV and battery) and an M-TEC **heat pump** from an MQTT broker, creates typed ioBroker data points and analyses the energy flows: house consumption, self-sufficiency, battery forecast, PV surplus, cost, savings and daily values.

The adapter only reads. It never writes anything back to the devices.

> This adapter is a private community project. It is **not affiliated with, endorsed or supported by M-TEC**. All product names belong to their owners.

[Deutsche Beschreibung weiter unten](#deutsch)

## Data sources

The adapter does not talk to the devices directly. It reads their values from an MQTT broker, in one of two formats ("input profiles"):

| Profile | Devices | Source |
|---|---|---|
| `json` | Energy Butler and heat pump | One topic per device with a JSON message of `fields` and `timestamp`. Any source can produce it, for example Node-RED or a script. [Format description](docs/profile-json.md) |
| `mtecmqtt` | Energy Butler | The MQTT output of [MTECmqtt](https://github.com/croedel/MTECmqtt). [Details and mapping](docs/profile-mtecmqtt.md) |

With `mtecmqtt` the heat pump can still be read via `json` at the same time.

Direct access via Modbus (without extra software) is planned for a later version.

## Installation

Requirements: Node.js 22 or newer, js-controller 6.0.11 or newer, admin 7.6.20 or newer.

The adapter is not yet published on npm. To test it, build the package and install it on the ioBroker host (default installation in `/opt/iobroker`):

```bash
npm pack
```

On the ioBroker host:

```bash
sudo mkdir -p /opt/iobroker/local-adapters
sudo mv iobroker.mtec-<version>.tgz /opt/iobroker/local-adapters/
sudo chown -R iobroker:iobroker /opt/iobroker/local-adapters
cd /opt/iobroker
sudo -u iobroker -H npm install ./local-adapters/iobroker.mtec-<version>.tgz --omit=dev
iobroker upload mtec
iobroker add mtec
```

The package has to stay in `local-adapters`: npm records the path in `/opt/iobroker/package.json`, and updates of other adapters fail if the file is missing later.

## Configuration

| Setting | Meaning |
|---|---|
| Broker, port, user, password | Connection to the MQTT broker. The password is stored encrypted. |
| Input profile | `json` or `mtecmqtt` |
| Topics (`json`) | One topic per device, empty = device not present |
| Topic prefix, serial number (`mtecmqtt`) | `MQTT_TOPIC` of MTECmqtt (default `MTEC`); serial number empty = first one seen |
| Data counts as outdated after | Limit for `info.stale` (default 20 s) |
| Slow MTECmqtt groups count as outdated after | Limit for phase and PV string values (default 180 s) |
| Analysis | Usable battery capacity, minimum state of charge, grid price and feed-in tariff (cents per kWh, 0 = not set, values below 1 are read as currency units per kWh), currency, threshold for "solar power to spare" |

If everything works, `mtec.0.info.connection` is `true`, the data points below `mtec.0.butler.*` (and `mtec.0.heatpump.*`) fill up and `info.stale` is `false`.

## Data points

| Path | Content |
|---|---|
| `info.connection` | Connection to the broker |
| `heatpump.<field>` | 25 values of the heat pump with unit and role, status codes with texts |
| `butler.<field>` | 16 values of the Energy Butler |
| `butler.mtecmqtt.<group>.<name>` | Further values from MTECmqtt (profile `mtecmqtt` only) |
| `<device>.info.lastMeasurement` | Time of the last measurement (ms) |
| `<device>.info.stale` | `true` if the last measurement is older than the configured limit |
| `butler.info.serial` | Serial number (profile `mtecmqtt` only) |

- **Time of measurement:** With `json`, every value gets the time of measurement from the message as `ts`, so history adapters store the real time of measurement.
- **Missing is not 0:** A value that is not reported becomes `null` with quality `0x82` (sensor reported no value); an old value does not stay.
- **For your own logic:** Always check `info.stale` before using a value for a switching decision.

## Analysis

Below `analysis` the adapter calculates from the live values of the Energy Butler:

| Data point | Content |
|---|---|
| `house_power_w` / `house_without_heatpump_w` | House consumption now (PV + import + discharging − export − charging), with and without heat pump |
| `autarky_percent` / `self_consumption_percent` | Self-sufficiency and PV self-consumption now |
| `surplus_w` / `surplus_available` | PV surplus (5 min average) and "solar power to spare" (with hysteresis) |
| `battery_energy_kwh`, `battery_full_in_min`, `battery_empty_in_min`, `battery_status_text` | Battery content and forecast, e.g. "full in 2 h 15 min (approx. 14:35)" |
| `cost_now_per_h` / `savings_now_per_h` | Electricity cost and savings per hour now (only with a configured price) |
| `grid_balance_per_h` / `grid_balance_text` | Grid balance now: + feed-in revenue / − import cost per hour, as number and as text ("+0.27 €/h") |
| `today.*` | Daily values since midnight: PV, import, export, battery, house, heat pump (electricity, heat, COP), self-sufficiency, `cost`, `savings` |

Amounts use the configured currency as unit. The texts follow the system language (German or English).

The daily values are estimated from the power (power × time since the previous measurement, gaps over 60 s are skipped) and survive a restart on the same day. With the profile `mtecmqtt` the real daily energy counters of the Energy Butler replace the estimate.

## Checking a broker

For the profile `json`, `tools/mqtt-check.mjs` listens for a few seconds and compares the fields with the adapter's definitions. With `--user` it asks for the password (hidden input, or from `MQTT_PASSWORD`):

```bash
node tools/mqtt-check.mjs --host <broker> --user <user>
```

## Development

```bash
npm install
npm test
```

The tests cover both input profiles, the analysis and the whole path through a local MQTT broker (aedes). `npm run test:integration` additionally starts the adapter in a real js-controller and checks the data flow from a local broker, `npm run lint` checks the code style.

## Deutsch

Der Adapter liest einen M-TEC **Energy Butler** (Hybrid-Wechselrichter mit PV und Akku) und eine M-TEC **Wärmepumpe** von einem MQTT-Broker, legt typisierte ioBroker-Datenpunkte an und wertet die Energieflüsse aus: Hausverbrauch, Autarkie, Akku-Prognose, PV-Überschuss, Kosten, Ersparnis und Tageswerte.

Der Adapter liest nur. Er schreibt nie etwas an die Geräte zurück.

> Dieser Adapter ist ein privates Community-Projekt. Er ist **nicht mit M-TEC verbunden** und wird von M-TEC weder unterstützt noch empfohlen. Alle Produktnamen gehören ihren Inhabern.

### Datenquellen

Der Adapter spricht nicht direkt mit den Geräten. Er liest ihre Werte von einem MQTT-Broker, in einem von zwei Formaten („Eingangsprofile“):

| Profil | Geräte | Quelle |
|---|---|---|
| `json` | Energy Butler und Wärmepumpe | Ein Topic je Gerät mit einer JSON-Nachricht aus `fields` und `timestamp`. Jede Quelle kann sie erzeugen, z. B. Node-RED oder ein Skript. [Formatbeschreibung](docs/profile-json.md) (englisch) |
| `mtecmqtt` | Energy Butler | Die MQTT-Ausgabe von [MTECmqtt](https://github.com/croedel/MTECmqtt). [Details und Zuordnung](docs/profile-mtecmqtt.md) (englisch) |

Mit `mtecmqtt` kann die Wärmepumpe gleichzeitig weiter über `json` gelesen werden.

Ein direkter Zugriff über Modbus (ohne Zusatzsoftware) ist für eine spätere Version geplant.

### Installation

Voraussetzungen: Node.js 22 oder neuer, js-controller 6.0.11 oder neuer, Admin 7.6.20 oder neuer.

Der Adapter ist noch nicht auf npm veröffentlicht. Zum Testen das Paket bauen und auf dem ioBroker-Host installieren (Standardinstallation unter `/opt/iobroker`):

```bash
npm pack
```

Auf dem ioBroker-Host:

```bash
sudo mkdir -p /opt/iobroker/local-adapters
sudo mv iobroker.mtec-<version>.tgz /opt/iobroker/local-adapters/
sudo chown -R iobroker:iobroker /opt/iobroker/local-adapters
cd /opt/iobroker
sudo -u iobroker -H npm install ./local-adapters/iobroker.mtec-<version>.tgz --omit=dev
iobroker upload mtec
iobroker add mtec
```

Das Paket muss in `local-adapters` liegen bleiben: npm trägt den Pfad in `/opt/iobroker/package.json` ein, und Updates anderer Adapter schlagen fehl, wenn die Datei später fehlt.

### Einrichtung

| Einstellung | Bedeutung |
|---|---|
| Broker, Port, Benutzer, Passwort | Verbindung zum MQTT-Broker. Das Passwort wird verschlüsselt gespeichert. |
| Eingangsprofil | `json` oder `mtecmqtt` |
| Topics (`json`) | Ein Topic je Gerät, leer = Gerät nicht vorhanden |
| Topic-Präfix, Seriennummer (`mtecmqtt`) | `MQTT_TOPIC` von MTECmqtt (Standard `MTEC`); Seriennummer leer = die erste gesehene |
| Daten gelten als veraltet nach | Grenze für `info.stale` (Standard 20 s) |
| Langsame MTECmqtt-Gruppen gelten als veraltet nach | Grenze für Phasen- und PV-String-Werte (Standard 180 s) |
| Auswertung | Nutzbare Akku-Kapazität, Mindestladestand, Strompreis und Einspeisevergütung (Cent pro kWh, 0 = nicht gesetzt, Werte unter 1 gelten als Währungseinheit pro kWh), Währung, Schwelle für „Sonnenstrom übrig“ |

Läuft alles, ist `mtec.0.info.connection` `true`, die Datenpunkte unter `mtec.0.butler.*` (und `mtec.0.heatpump.*`) füllen sich, und `info.stale` steht auf `false`.

### Datenpunkte

| Pfad | Inhalt |
|---|---|
| `info.connection` | Verbindung zum Broker |
| `heatpump.<feld>` | 25 Werte der Wärmepumpe mit Einheit und Rolle, Statuscodes mit Texten |
| `butler.<feld>` | 16 Werte des Energy Butlers |
| `butler.mtecmqtt.<gruppe>.<name>` | Weitere Werte von MTECmqtt (nur Profil `mtecmqtt`) |
| `<gerät>.info.lastMeasurement` | Zeitpunkt der letzten Messung (ms) |
| `<gerät>.info.stale` | `true`, wenn die letzte Messung älter ist als die eingestellte Grenze |
| `butler.info.serial` | Seriennummer (nur Profil `mtecmqtt`) |

- **Messzeitpunkt:** Mit `json` bekommt jeder Wert den Messzeitpunkt aus der Nachricht als `ts`. Verlaufs-Adapter speichern damit die echte Messzeit.
- **Fehlend ist nicht 0:** Ein nicht gemeldeter Wert wird `null` mit Qualität `0x82` (Sensor hat keinen Wert gemeldet). Ein alter Wert bleibt also nicht stehen.
- **Für eigene Logik:** Vor einer Schaltentscheidung immer zuerst `info.stale` prüfen.

### Auswertung

Unter `analysis` rechnet der Adapter aus den Live-Werten des Energy Butlers:

| Datenpunkt | Inhalt |
|---|---|
| `house_power_w` / `house_without_heatpump_w` | Hausverbrauch jetzt (PV + Bezug + Entladen − Einspeisung − Laden), mit und ohne Wärmepumpe |
| `autarky_percent` / `self_consumption_percent` | Autarkie und Eigenverbrauch der PV jetzt |
| `surplus_w` / `surplus_available` | PV-Überschuss (Mittel über 5 min) und „Sonnenstrom übrig“ (mit Hysterese) |
| `battery_energy_kwh`, `battery_full_in_min`, `battery_empty_in_min`, `battery_status_text` | Akku-Inhalt und Prognose, z. B. „voll in 2 h 15 min (ca. 14:35 Uhr)“ |
| `cost_now_per_h` / `savings_now_per_h` | Stromkosten und Ersparnis pro Stunde jetzt (nur mit eingetragenem Strompreis) |
| `grid_balance_per_h` / `grid_balance_text` | Netz-Bilanz jetzt: + Einspeiseerlös / − Bezugskosten pro Stunde, als Zahl und als Text („+0,27 €/h“) |
| `today.*` | Tageswerte seit Mitternacht: PV, Bezug, Einspeisung, Akku, Haus, Wärmepumpe (Strom, Wärme, COP), Autarkie, `cost`, `savings` |

Geldbeträge haben die eingestellte Währung als Einheit. Die Texte folgen der Systemsprache (Deutsch oder Englisch).

Die Tageswerte werden aus der Leistung hochgerechnet (Leistung × Zeit seit der vorigen Messung, Lücken über 60 s werden ausgelassen) und überstehen einen Neustart am selben Tag. Mit dem Profil `mtecmqtt` ersetzen die echten Tageszähler des Energy Butlers die Hochrechnung.

**Umstieg von 0.3.0:** Die Geld-Datenpunkte heißen jetzt `cost_now_per_h`, `savings_now_per_h`, `grid_balance_per_h`, `today.cost` und `today.savings`. Der Adapter übernimmt die heutigen Werte und löscht die alten Datenpunkte. Skripte und Visualisierungen bitte anpassen.

### Broker prüfen

Für das Profil `json` hört `tools/mqtt-check.mjs` einige Sekunden mit und vergleicht die Felder mit den Definitionen des Adapters. Mit `--user` fragt es nach dem Passwort (verdeckte Eingabe, alternativ aus `MQTT_PASSWORD`):

```bash
node tools/mqtt-check.mjs --host <broker> --user <benutzer>
```

### Entwicklung

```bash
npm install
npm test
```

Die Tests prüfen beide Eingangsprofile, die Auswertung und den ganzen Weg über einen lokalen MQTT-Broker (aedes). `npm run test:integration` startet den Adapter zusätzlich in einem echten js-controller und prüft den Datenfluss von einem lokalen Broker, `npm run lint` prüft den Code-Stil.

Changelog und Lizenz stehen unten auf Englisch.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

- (breaking) Money data points renamed: `analysis.cost_now_eur_h` → `cost_now_per_h`, `savings_now_eur_h` → `savings_now_per_h`, `grid_balance_eur_h` → `grid_balance_per_h`, `today.cost_eur` → `today.cost`, `today.savings_eur` → `today.savings`. Today's values are taken over, the old objects are deleted.
- New input profile `mtecmqtt`: Energy Butler via the MQTT output of MTECmqtt, including further values and real daily energy counters
- Input profile selection in the admin interface
- English as base language: log messages, data point names (English and German), admin interface with translations; texts follow the system language
- Public description of the `json` format
- (breaking) Requires Node.js 22, js-controller 6.0.11 and admin 7.6.20 or newer
- Admin interface and adapter description in all ioBroker languages

### 0.3.0 (2026-10-17)

- Configurable currency; grid balance (+ revenue / − cost per hour) as number and text

### 0.2.1 (2026-10-17)

- Prices below 1 are read as currency units per kWh; clearer labels

### 0.2.0 (2026-10-17)

- Analysis: house consumption, self-sufficiency, battery forecast, cost/savings, daily values

### 0.1.0 (2026-10-15)

- Initial version: read heat pump and Energy Butler telemetry via MQTT

## License

MIT License

Copyright (c) 2026 derDennis99

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
