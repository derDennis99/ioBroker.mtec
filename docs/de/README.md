# ioBroker.mtec – Beschreibung auf Deutsch

Der Adapter liest einen M-TEC **Energy Butler** (Hybrid-Wechselrichter mit PV und Akku) und eine M-TEC **Wärmepumpe** von einem MQTT-Broker, legt typisierte ioBroker-Datenpunkte an und wertet die Energieflüsse aus: Hausverbrauch, Autarkie, Akku-Prognose, PV-Überschuss, Kosten, Ersparnis und Tageswerte.

Der Adapter liest nur. Er schreibt nie etwas an die Geräte zurück.

> Dieser Adapter ist ein privates Community-Projekt. Er ist **nicht mit M-TEC verbunden** und wird von M-TEC weder unterstützt noch empfohlen. Alle Produktnamen gehören ihren Inhabern.

## Datenquellen

Der Adapter spricht nicht direkt mit den Geräten. Er liest ihre Werte von einem MQTT-Broker, in einem von zwei Formaten („Eingangsprofile“):

| Profil | Geräte | Quelle |
|---|---|---|
| `json` | Energy Butler und Wärmepumpe | Ein Topic je Gerät mit einer JSON-Nachricht aus `fields` und `timestamp`. Jede Quelle kann sie erzeugen, z. B. Node-RED oder ein Skript. [Formatbeschreibung](../profile-json.md) (englisch) |
| `mtecmqtt` | Energy Butler | Die MQTT-Ausgabe von [MTECmqtt](https://github.com/croedel/MTECmqtt). [Details und Zuordnung](../profile-mtecmqtt.md) (englisch) |

Mit `mtecmqtt` kann die Wärmepumpe gleichzeitig weiter über `json` gelesen werden.

Ein direkter Zugriff über Modbus (ohne Zusatzsoftware) ist für eine spätere Version geplant.

## Installation

Voraussetzungen: Node.js 22 oder neuer, js-controller 6.0.11 oder neuer, Admin 7.6.20 oder neuer.

Der Adapter ist auf npm veröffentlicht und wird gerade ins ioBroker-Repository aufgenommen. Sobald er dort gelistet ist, im Admin unter *Adapter* nach „mtec“ suchen, installieren und eine Instanz anlegen.

## Einrichtung

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

## Datenpunkte

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

## Auswertung

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

## Broker prüfen

Für das Profil `json` hört `tools/mqtt-check.mjs` einige Sekunden mit und vergleicht die Felder mit den Definitionen des Adapters. Mit `--user` fragt es nach dem Passwort (verdeckte Eingabe, alternativ aus `MQTT_PASSWORD`):

```bash
node tools/mqtt-check.mjs --host <broker> --user <benutzer>
```

## Entwicklung

```bash
npm install
npm test
```

Die Tests prüfen beide Eingangsprofile, die Auswertung und den ganzen Weg über einen lokalen MQTT-Broker (aedes). `npm run test:integration` startet den Adapter zusätzlich in einem echten js-controller und prüft den Datenfluss von einem lokalen Broker, `npm run lint` prüft den Code-Stil.

Changelog und Lizenz stehen im englischen [README](../../README.md).
