"""Build data/campaign/rise-of-the-guptas.json: the 319 CE campaign map, realms, armies and economy.

Run from the repository root:  python tools/make-rise-campaign.py
Positions are real (longitude, latitude); borders, armies and dates are simplified. The script
checks that towns stay clear of rivers and of each other, and that every road joins real towns.
"""
import json
import math
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'data', 'campaign', 'rise-of-the-guptas.json')
HUNA = json.load(open(os.path.join(ROOT, 'data', 'campaign', 'north-india.json'), encoding='utf8'))


def u(t, n=None, s=None, g=False):
    d = {"type": t}
    if n:
        d["name"] = n
    if s is not None:
        d["strength"] = s
    if g:
        d["general"] = True
    return d


def army(name, faction, at, units):
    return {"name": name, "faction": faction, "at": at, "units": units}


def F(name, color, capital, recruits, move=150, fast=185, ai=True):
    f = {"name": name, "color": color, "capital": capital}
    if ai:
        f["ai"] = True
    f.update({"move": move, "fastMove": fast, "recruits": recruits})
    return f


def T(id, name, lon, lat, owner, note=None):
    t = {"id": id, "name": name, "pos": [lon, lat], "owner": owner}
    if note:
        t["note"] = note
    return t


FOOT = ["levy-spearmen", "archers", "heavy-infantry"]
factions = {
    "gupta": F("Gupta Empire", "#e0a030", "pataliputra", FOOT + ["heavy-cavalry", "war-elephants", "gupta-imperial-archers", "gupta-royal-elephants"], ai=False),
    "licchavi": F("Licchavi Republic", "#2fa39a", "vaishali", FOOT + ["licchavi-assembly-guard"]),
    "vanga": F("Kingdom of Vanga", "#3b6fc4", "gauda", ["levy-spearmen", "archers", "war-elephants", "skirmishers", "vanga-river-archers"], 145, 180),
    "naga": F("Naga Kings", "#4f9a3a", "padmavati", FOOT + ["heavy-cavalry", "war-elephants", "naga-spearmen"]),
    "ahichchhatra": F("Kingdom of Ahichchhatra", "#8f5bc0", "ahichchhatra", FOOT + ["heavy-cavalry", "panchala-swordsmen"]),
    "yaudheya": F("Yaudheya Republic", "#6f86d6", "rohitaka", ["heavy-infantry", "levy-spearmen", "heavy-cavalry", "archers", "yaudheya-warriors"]),
    "madraka": F("Madraka Republic", "#9a6b3c", "sakala", ["heavy-cavalry", "levy-spearmen", "archers", "madraka-horse"]),
    "kushan": F("Kushan Kingdom", "#56657a", "purushapura", ["steppe-lancers", "horse-archers", "heavy-infantry", "archers", "kushan-cataphracts"], 150, 190),
    "malava": F("Malava Republic", "#d0709e", "madhyamika", FOOT + ["heavy-cavalry", "malava-guardsmen"]),
    "kshatrapa": F("Western Kshatrapas", "#c0403a", "ujjayini", ["horse-archers", "heavy-cavalry", "levy-spearmen", "archers", "skirmishers", "saka-horse-archers"], 150, 190),
    "vakataka": F("Vakataka Kingdom", "#a8a030", "nandivardhana", ["levy-spearmen", "archers", "war-elephants", "heavy-infantry", "deccan-elephants"], 145, 180),
    "parthian": F("Parthians of Sakastan", "#8c2d4a", "zarang", ["steppe-lancers", "horse-archers", "archers", "parthian-cataphracts", "parthian-horse-archers"], 150, 195),
    "pallava": F("Pallava Kingdom", "#e06a2a", "kanchipuram", FOOT + ["war-elephants", "heavy-cavalry", "pallava-spearmen"]),
    "salankayana": F("Salankayanas of Vengi", "#1f6f5c", "vengi", FOOT + ["war-elephants", "vengi-archers"]),
    "kalinga": F("Kingdom of Kalinga", "#5fb0d8", "pishtapura", ["levy-spearmen", "archers", "war-elephants", "kalinga-elephants"]),
    "kosala": F("Kingdom of Kosala", "#9cc43a", "sripura", ["levy-spearmen", "archers", "skirmishers", "kosala-forest-archers"]),
    "kadamba": F("Kadambas of Vanavasi", "#b5338a", "vanavasi", FOOT + ["heavy-cavalry", "kadamba-swordsmen"]),
    "ganga": F("Western Gangas", "#4b3f9e", "kolar", FOOT + ["war-elephants", "ganga-spearmen"]),
    "kalabhra": F("Kalabhras", "#6b4e2e", "madurai", ["levy-spearmen", "skirmishers", "archers", "kalabhra-raiders"]),
    "chera": F("Chera Kingdom", "#e3d24a", "karur", FOOT + ["war-elephants", "chera-bowmen"]),
}

settlements = [
    # Magadha and the Ganga
    T("pataliputra", "Pataliputra", 85.14, 25.68, "gupta", "Capital of Magadha"),
    T("gaya", "Gaya", 85.0, 24.78, "gupta", "Southern Magadha"),
    T("varanasi", "Varanasi", 83.0, 25.4, "gupta"),
    T("prayaga", "Prayaga", 81.75, 25.6, "gupta", "Where the Ganga meets the Yamuna"),
    T("saketa", "Saketa", 82.2, 26.75, "gupta", "Ayodhya"),
    T("vaishali", "Vaishali", 85.35, 26.2, "licchavi", "Home of queen Kumaradevi's people"),
    T("mithila", "Mithila", 85.9, 26.72, "licchavi"),
    T("champa", "Champa", 87.0, 25.25, "vanga", "Old capital of Anga"),
    T("gauda", "Gauda", 88.0, 25.05, "vanga"),
    T("tamralipti", "Tamralipti", 87.65, 22.45, "vanga", "Port on the Bay of Bengal"),
    # Aryavarta
    T("padmavati", "Padmavati", 78.2, 25.9, "naga", "Seat of king Nagasena"),
    T("mathura", "Mathura", 77.45, 27.55, "naga", "Held by Ganapatinaga"),
    T("vidisha", "Vidisha", 77.8, 23.52, "naga"),
    T("ahichchhatra", "Ahichchhatra", 79.13, 28.37, "ahichchhatra", "Seat of king Achyuta"),
    T("kanyakubja", "Kanyakubja", 79.85, 26.95, "ahichchhatra"),
    T("rohitaka", "Rohitaka", 76.6, 28.9, "yaudheya", "Yaudheya assembly town"),
    T("sthanvishvara", "Sthanvishvara", 76.83, 29.97, "yaudheya"),
    T("sakala", "Sakala", 74.53, 32.49, "madraka", "Madraka capital"),
    T("madhyamika", "Madhyamika", 74.6, 24.9, "malava", "Malava stronghold"),
    T("pushkara", "Pushkara", 74.55, 26.49, "malava", "Lake shrine at the edge of the Thar"),
    T("ujjayini", "Ujjayini", 75.78, 23.18, "kshatrapa", "Seat of the Saka satraps"),
    T("bharukaccha", "Bharukaccha", 72.95, 21.85, "kshatrapa", "Port at the mouth of the Narmada"),
    # The north-west and beyond the Indus
    T("purushapura", "Purushapura", 71.57, 34.0, "kushan", "Kushan seat below the passes"),
    T("takshashila", "Takshashila", 72.83, 33.74, "kushan"),
    T("mulasthana", "Mulasthana", 71.47, 30.2, "kushan"),
    T("kapisa", "Kapisa", 69.25, 34.95, "kushan", "Summer capital in the Kabul valley"),
    T("ghazna", "Ghazna", 68.42, 33.55, "kushan"),
    T("zarang", "Zarang", 61.75, 30.85, "parthian", "Seat of the Parthian house of Suren in Sakastan"),
    T("kandahar", "Kandahar", 65.7, 31.6, "parthian", "Arachosia"),
    T("herat", "Herat", 62.2, 34.35, "parthian", "Aria"),
    # The Deccan
    T("nandivardhana", "Nandivardhana", 79.3, 21.4, "vakataka", "Vakataka capital"),
    T("vatsagulma", "Vatsagulma", 77.15, 20.1, "vakataka"),
    T("pratishthana", "Pratishthana", 75.38, 19.75, "vakataka", "Old Satavahana capital on the Godavari"),
    T("sripura", "Sripura", 82.1, 21.45, "kosala", "Capital of Dakshina Kosala"),
    # The east coast
    T("tosali", "Tosali", 85.75, 20.15, "kalinga"),
    T("kalinganagara", "Kalinganagara", 83.9, 18.6, "kalinga"),
    T("pishtapura", "Pishtapura", 82.25, 17.1, "kalinga", "Seat of king Mahendragiri"),
    T("vengi", "Vengi", 81.1, 16.75, "salankayana", "Seat of king Hastivarman"),
    # The far south
    T("vijayapuri", "Vijayapuri", 79.3, 16.52, "pallava", "Old Ikshvaku capital on the Krishna"),
    T("nellore", "Nellore", 79.98, 14.44, "pallava"),
    T("kanchipuram", "Kanchipuram", 79.7, 12.83, "pallava", "Seat of king Vishnugopa"),
    T("vanavasi", "Vanavasi", 75.0, 14.55, "kadamba", "Kadamba capital"),
    T("kolhapura", "Kolhapura", 74.24, 16.7, "kadamba"),
    T("kolar", "Kolar", 78.13, 13.14, "ganga", "Early seat of the Western Gangas"),
    T("madurai", "Madurai", 78.12, 9.92, "kalabhra", "Taken from the Pandyas"),
    T("uraiyur", "Uraiyur", 78.68, 10.7, "kalabhra", "Old Chola capital"),
    T("karur", "Karur", 78.08, 10.96, "chera", "Chera capital, Vanji"),
    T("muziris", "Muziris", 76.4, 10.2, "chera", "Pepper port of the Roman trade"),
]

roads = [
    ("pataliputra", "gaya"), ("pataliputra", "vaishali"), ("vaishali", "mithila"), ("pataliputra", "varanasi"), ("gaya", "varanasi"),
    ("pataliputra", "champa"), ("champa", "gauda"), ("gauda", "tamralipti"), ("gaya", "tamralipti"),
    ("varanasi", "prayaga"), ("varanasi", "saketa"), ("saketa", "prayaga"), ("saketa", "mithila"),
    ("prayaga", "kanyakubja"), ("saketa", "kanyakubja"), ("kanyakubja", "ahichchhatra"), ("kanyakubja", "mathura"), ("ahichchhatra", "mathura"),
    ("ahichchhatra", "sthanvishvara"), ("mathura", "padmavati"), ("prayaga", "padmavati"), ("padmavati", "vidisha"), ("vidisha", "prayaga"),
    ("vidisha", "ujjayini"), ("vidisha", "nandivardhana"), ("ujjayini", "nandivardhana"), ("ujjayini", "bharukaccha"), ("ujjayini", "madhyamika"),
    ("ujjayini", "mathura"), ("madhyamika", "pushkara"), ("madhyamika", "bharukaccha"), ("pushkara", "mathura"), ("pushkara", "rohitaka"),
    ("rohitaka", "mathura"), ("rohitaka", "sthanvishvara"), ("sthanvishvara", "sakala"), ("sakala", "takshashila"), ("purushapura", "takshashila"),
    ("purushapura", "mulasthana"), ("mulasthana", "sakala"), ("mulasthana", "pushkara"),
    # west
    ("purushapura", "kapisa"), ("kapisa", "ghazna"), ("ghazna", "purushapura"), ("ghazna", "kandahar"),
    ("kandahar", "zarang"), ("zarang", "herat"), ("herat", "kandahar"),
    # Deccan and the east coast
    ("nandivardhana", "vatsagulma"), ("vatsagulma", "pratishthana"), ("pratishthana", "ujjayini"), ("pratishthana", "bharukaccha"),
    ("nandivardhana", "sripura"), ("sripura", "gaya"), ("sripura", "tosali"), ("tosali", "tamralipti"),
    ("tosali", "kalinganagara"), ("kalinganagara", "pishtapura"), ("pishtapura", "vengi"), ("vengi", "vijayapuri"),
    ("vatsagulma", "vijayapuri"),
    # south
    ("pratishthana", "kolhapura"), ("kolhapura", "vanavasi"), ("vanavasi", "kolar"), ("vijayapuri", "nellore"), ("nellore", "kanchipuram"),
    ("vijayapuri", "kolar"), ("kolar", "kanchipuram"), ("kolar", "karur"), ("kanchipuram", "uraiyur"),
    ("karur", "uraiyur"), ("karur", "madurai"), ("uraiyur", "madurai"), ("karur", "muziris"),
]

rivers = HUNA["rivers"] + [
    {"name": "Godavari", "points": [[73.7, 20.0], [75.3, 19.5], [77.3, 19.0], [79.0, 18.8], [80.2, 18.6], [81.0, 17.6], [81.8, 16.6]]},
    {"name": "Krishna", "points": [[73.7, 17.9], [74.6, 16.8], [76.2, 16.3], [77.8, 16.2], [78.9, 16.4], [80.0, 16.2], [80.9, 15.8]]},
    {"name": "Tungabhadra", "points": [[75.3, 13.9], [75.8, 14.8], [76.4, 15.4], [77.5, 15.9], [78.1, 16.0]]},
    {"name": "Kaveri", "points": [[75.6, 12.4], [76.5, 12.3], [77.4, 12.1], [77.8, 11.4], [78.6, 10.9], [79.4, 10.95], [79.85, 11.0]]},
    {"name": "Mahanadi", "points": [[81.8, 21.0], [82.8, 21.3], [83.9, 20.9], [85.0, 20.5], [86.3, 20.3]]},
    {"name": "Helmand", "points": [[67.0, 34.6], [65.5, 33.0], [64.4, 31.6], [63.3, 30.8], [62.2, 31.1], [61.6, 31.0]]},
]

# The Himalayan / Hindu Kush crest, extended west across Iran.
ridge = [[58.5, 36.3], [61.0, 36.0], [63.5, 35.8], [66.0, 35.5]] + HUNA["ridge"]

hills = HUNA["hills"] + [
    # Western Ghats
    {"pos": [73.7, 18.6], "radius": 0.55, "height": 11}, {"pos": [73.9, 17.3], "radius": 0.55, "height": 11},
    {"pos": [74.25, 15.9], "radius": 0.55, "height": 11}, {"pos": [74.65, 14.2], "radius": 0.55, "height": 12},
    {"pos": [75.4, 12.6], "radius": 0.6, "height": 13}, {"pos": [76.7, 11.4], "radius": 0.6, "height": 17},
    {"pos": [77.15, 9.9], "radius": 0.55, "height": 14}, {"pos": [77.35, 8.8], "radius": 0.45, "height": 11},
    # Eastern Ghats
    {"pos": [83.0, 19.0], "radius": 0.7, "height": 9}, {"pos": [82.1, 18.1], "radius": 0.65, "height": 8},
    {"pos": [80.4, 15.2], "radius": 0.6, "height": 6}, {"pos": [79.3, 13.7], "radius": 0.6, "height": 6},
    # Deccan plateau swells
    {"pos": [76.6, 17.6], "radius": 1.6, "height": 4}, {"pos": [78.3, 17.4], "radius": 1.5, "height": 4},
    {"pos": [77.0, 14.6], "radius": 1.3, "height": 4},
    # Afghan and Baluch highlands
    {"pos": [65.2, 33.6], "radius": 1.6, "height": 18}, {"pos": [67.0, 33.0], "radius": 1.0, "height": 16},
    {"pos": [66.8, 30.0], "radius": 0.9, "height": 13}, {"pos": [62.4, 26.6], "radius": 1.2, "height": 8},
    {"pos": [64.8, 27.0], "radius": 1.2, "height": 9}, {"pos": [60.2, 33.0], "radius": 1.0, "height": 10},
]

deserts = HUNA["deserts"] + [
    {"pos": [59.6, 30.5], "radius": 2.0, "height": 1},   # Dasht-e Lut
    {"pos": [65.0, 30.2], "radius": 1.4, "height": 1},   # Registan
    {"pos": [63.2, 29.9], "radius": 1.2, "height": 1},   # Dasht-i Margo
]

seas = [
    # Arabian Sea: Makran coast, Gujarat, the west coast down to Kanyakumari.
    [[57, 25.6], [59.5, 25.4], [62.3, 25.1], [64.5, 25.3], [66.6, 25.4], [67.2, 24.8], [68.4, 23.5], [69.2, 22.6], [70.2, 21.0],
     [71.4, 20.75], [72.6, 21.15], [72.85, 20.4], [72.85, 19.0], [73.3, 17.0], [73.8, 15.4], [74.1, 14.8], [74.85, 12.9],
     [75.8, 11.25], [76.25, 9.95], [76.6, 8.9], [77.55, 8.05], [77.6, 6.5], [57, 6.5]],
    # Bay of Bengal: the east coast from Kanyakumari to the Ganga delta.
    [[77.55, 8.05], [78.15, 8.8], [79.3, 9.3], [79.85, 10.3], [79.85, 11.5], [80.3, 13.1], [80.1, 14.5], [80.05, 15.5],
     [81.15, 16.2], [82.25, 16.9], [83.3, 17.7], [84.9, 19.25], [85.8, 19.8], [86.6, 20.6], [86.9, 21.6], [87.4, 21.8],
     [88.6, 21.7], [89.5, 21.95], [93, 22.3], [93, 6.5], [77.6, 6.5]],
]

armies = [
    army("Army of Chandragupta", "gupta", "pataliputra", [u("gupta-imperial-archers", "Imperial Archers"), u("archers", "Magadha Archers"), u("gupta-royal-elephants", "Royal Elephants"), u("heavy-infantry", "Swordsmen of Pataliputra I"), u("heavy-infantry", "Swordsmen of Pataliputra II"), u("levy-spearmen", "Magadha Spearmen I"), u("levy-spearmen", "Magadha Spearmen II"), u("heavy-cavalry", "Magadha Lancers"), u("heavy-cavalry", "Maharaja's Guard", 0.6, True)]),
    army("Prayaga Garrison", "gupta", "prayaga", [u("levy-spearmen", "Prayaga Spearmen I"), u("levy-spearmen", "Prayaga Spearmen II"), u("archers", "Prayaga Archers"), u("heavy-cavalry", "Commander's Guard", 0.5, True)]),
    army("Licchavi Host", "licchavi", "vaishali", [u("levy-spearmen", "Vajji Spearmen I"), u("levy-spearmen", "Vajji Spearmen II"), u("archers", "Vajji Archers"), u("licchavi-assembly-guard", "Assembly Guard"), u("heavy-infantry", "Licchavi Swordsmen"), u("heavy-cavalry", "Gana Guard", 0.5, True)]),
    army("Host of Vanga", "vanga", "gauda", [u("war-elephants", "Vanga Elephants I"), u("war-elephants", "Vanga Elephants II"), u("vanga-river-archers", "Boat Archers"), u("archers", "Vanga Archers"), u("levy-spearmen", "Vanga Spearmen I"), u("levy-spearmen", "Vanga Spearmen II"), u("skirmishers", "River Skirmishers"), u("heavy-cavalry", "King's Guard", 0.5, True)]),
    army("Host of Nagasena", "naga", "padmavati", [u("war-elephants", "Naga Elephants"), u("heavy-infantry", "Naga Swordsmen I"), u("heavy-infantry", "Naga Swordsmen II"), u("naga-spearmen", "Shield-Spearmen"), u("levy-spearmen", "Naga Spearmen"), u("archers", "Naga Archers I"), u("archers", "Naga Archers II"), u("heavy-cavalry", "Naga Lancers"), u("heavy-cavalry", "Nagasena's Guard", 0.6, True)]),
    army("Army of Ganapatinaga", "naga", "mathura", [u("levy-spearmen", "Mathura Spearmen I"), u("levy-spearmen", "Mathura Spearmen II"), u("archers", "Mathura Archers"), u("heavy-infantry", "Mathura Swordsmen"), u("heavy-cavalry", "Ganapatinaga's Guard", 0.5, True)]),
    army("Host of Achyuta", "ahichchhatra", "ahichchhatra", [u("panchala-swordsmen", "Household Swordsmen"), u("heavy-infantry", "Panchala Swordsmen"), u("levy-spearmen", "Panchala Spearmen I"), u("levy-spearmen", "Panchala Spearmen II"), u("archers", "Panchala Archers"), u("heavy-cavalry", "Panchala Lancers"), u("heavy-cavalry", "Achyuta's Guard", 0.5, True)]),
    army("Yaudheya Warband", "yaudheya", "rohitaka", [u("yaudheya-warriors", "Sworn Warriors"), u("heavy-infantry", "Yaudheya Swordsmen"), u("levy-spearmen", "Yaudheya Spearmen I"), u("levy-spearmen", "Yaudheya Spearmen II"), u("heavy-cavalry", "Yaudheya Horse I"), u("heavy-cavalry", "Yaudheya Horse II"), u("archers", "Yaudheya Archers"), u("heavy-cavalry", "Ganapati's Guard", 0.5, True)]),
    army("Madraka Horse", "madraka", "sakala", [u("madraka-horse", "Madraka Riders"), u("heavy-cavalry", "Madraka Horse"), u("levy-spearmen", "Madraka Spearmen I"), u("levy-spearmen", "Madraka Spearmen II"), u("archers", "Madraka Archers"), u("heavy-cavalry", "Assembly Guard", 0.5, True)]),
    army("Kushan Host", "kushan", "purushapura", [u("kushan-cataphracts", "Kushan Cataphracts"), u("steppe-lancers", "Kushan Lancers"), u("horse-archers", "Kushan Horse Archers I"), u("horse-archers", "Kushan Horse Archers II"), u("heavy-infantry", "Bactrian Foot I"), u("heavy-infantry", "Bactrian Foot II"), u("archers", "Gandhara Archers"), u("steppe-lancers", "Shah's Guard", 0.6, True)]),
    army("Taxila Garrison", "kushan", "takshashila", [u("heavy-infantry", "Taxila Foot"), u("archers", "Taxila Archers"), u("levy-spearmen", "Taxila Spearmen"), u("steppe-lancers", "Governor's Guard", 0.5, True)]),
    army("Malava Levy", "malava", "madhyamika", [u("malava-guardsmen", "Malava Guardsmen"), u("heavy-infantry", "Malava Swordsmen"), u("levy-spearmen", "Malava Spearmen I"), u("levy-spearmen", "Malava Spearmen II"), u("archers", "Malava Archers"), u("heavy-cavalry", "Malava Guard", 0.5, True)]),
    army("Host of the Satrap", "kshatrapa", "ujjayini", [u("saka-horse-archers", "Saka Horse Archers"), u("horse-archers", "Saka Riders"), u("heavy-cavalry", "Saka Lancers I"), u("heavy-cavalry", "Saka Lancers II"), u("levy-spearmen", "Avanti Spearmen I"), u("levy-spearmen", "Avanti Spearmen II"), u("archers", "Avanti Archers"), u("skirmishers", "Abhira Skirmishers"), u("heavy-cavalry", "Mahakshatrapa's Guard", 0.6, True)]),
    army("Vakataka Host", "vakataka", "nandivardhana", [u("deccan-elephants", "Deccan Elephants"), u("war-elephants", "Vakataka Elephants"), u("levy-spearmen", "Vakataka Spearmen I"), u("levy-spearmen", "Vakataka Spearmen II"), u("archers", "Vakataka Archers I"), u("archers", "Vakataka Archers II"), u("heavy-infantry", "Vakataka Swordsmen"), u("heavy-cavalry", "Pravarasena's Guard", 0.5, True)]),
    army("Host of Suren", "parthian", "zarang", [u("parthian-cataphracts", "Suren Cataphracts"), u("parthian-horse-archers", "Parthian Horse Archers I"), u("parthian-horse-archers", "Parthian Horse Archers II"), u("horse-archers", "Sakastan Riders"), u("archers", "Sakastan Archers"), u("steppe-lancers", "Suren's Guard", 0.6, True)]),
    army("Arachosian Riders", "parthian", "kandahar", [u("horse-archers", "Arachosian Horse Archers"), u("steppe-lancers", "Arachosian Lancers"), u("archers", "Kandahar Archers"), u("steppe-lancers", "Satrap's Guard", 0.5, True)]),
    army("Army of Vishnugopa", "pallava", "kanchipuram", [u("pallava-spearmen", "Pallava Spearmen"), u("levy-spearmen", "Kanchi Levy"), u("archers", "Kanchi Archers I"), u("archers", "Kanchi Archers II"), u("heavy-infantry", "Kanchi Swordsmen"), u("war-elephants", "Pallava Elephants"), u("heavy-cavalry", "Vishnugopa's Guard", 0.5, True)]),
    army("Host of Hastivarman", "salankayana", "vengi", [u("vengi-archers", "Vengi Archers"), u("levy-spearmen", "Vengi Spearmen I"), u("levy-spearmen", "Vengi Spearmen II"), u("war-elephants", "Vengi Elephants"), u("heavy-cavalry", "Hastivarman's Guard", 0.5, True)]),
    army("Host of Mahendragiri", "kalinga", "pishtapura", [u("kalinga-elephants", "Kalinga Elephants"), u("war-elephants", "Kalinga Elephants II"), u("levy-spearmen", "Kalinga Spearmen I"), u("levy-spearmen", "Kalinga Spearmen II"), u("archers", "Kalinga Archers"), u("heavy-cavalry", "Mahendragiri's Guard", 0.5, True)]),
    army("Host of Mahendra", "kosala", "sripura", [u("kosala-forest-archers", "Forest Archers"), u("skirmishers", "Forest Skirmishers"), u("levy-spearmen", "Kosala Spearmen I"), u("levy-spearmen", "Kosala Spearmen II"), u("archers", "Kosala Archers"), u("heavy-cavalry", "Mahendra's Guard", 0.5, True)]),
    army("Kadamba Host", "kadamba", "vanavasi", [u("kadamba-swordsmen", "Kadamba Swordsmen"), u("heavy-infantry", "Vanavasi Foot"), u("levy-spearmen", "Vanavasi Spearmen"), u("archers", "Vanavasi Archers"), u("heavy-cavalry", "Mayurasharma's Guard", 0.5, True)]),
    army("Ganga Host", "ganga", "kolar", [u("ganga-spearmen", "Ganga Spearmen"), u("levy-spearmen", "Kolar Levy"), u("archers", "Kolar Archers"), u("war-elephants", "Ganga Elephants"), u("heavy-cavalry", "Konganivarma's Guard", 0.5, True)]),
    army("Kalabhra Host", "kalabhra", "madurai", [u("kalabhra-raiders", "Kalabhra Raiders I"), u("kalabhra-raiders", "Kalabhra Raiders II"), u("levy-spearmen", "Madurai Levy"), u("archers", "Madurai Archers"), u("skirmishers", "Hill Skirmishers"), u("heavy-cavalry", "Kalabhra Chief's Guard", 0.5, True)]),
    army("Chera Host", "chera", "karur", [u("chera-bowmen", "Chera Longbowmen"), u("archers", "Vanji Archers"), u("levy-spearmen", "Vanji Spearmen I"), u("levy-spearmen", "Vanji Spearmen II"), u("war-elephants", "Chera Elephants"), u("heavy-cavalry", "Chera King's Guard", 0.5, True)]),
]

reinforcements = [
    {"faction": "gupta", "every": 5, "at": "pataliputra", "maxArmies": 4, "name": "Levy of Magadha", "units": [u("levy-spearmen", "Magadha Levy I"), u("levy-spearmen", "Magadha Levy II"), u("archers", "Magadha Levy Archers"), u("heavy-cavalry", "Marshal's Guard", 0.5, True)]},
    {"faction": "kushan", "every": 5, "at": "purushapura", "maxArmies": 3, "name": "Riders from Bactria", "units": [u("steppe-lancers", "Bactrian Lancers"), u("horse-archers", "Bactrian Horse Archers I"), u("horse-archers", "Bactrian Horse Archers II"), u("steppe-lancers", "Captain's Guard", 0.5, True)]},
    {"faction": "parthian", "every": 6, "at": "zarang", "maxArmies": 3, "name": "Riders of Suren", "units": [u("parthian-horse-archers", "Suren Horse Archers"), u("horse-archers", "Sakastan Riders"), u("steppe-lancers", "Suren Captain", 0.5, True)]},
]

# Money: every realm but the Guptas taxes its towns and pays to raise and keep troops.
COST = {"levy-spearmen": 60, "skirmishers": 60, "archers": 80, "heavy-infantry": 120, "heavy-cavalry": 160,
        "horse-archers": 140, "steppe-lancers": 170, "war-elephants": 260}
units_dir = os.path.join(ROOT, 'data', 'units')
for f in os.listdir(units_dir):
    t = json.load(open(os.path.join(units_dir, f), encoding='utf8'))
    if t.get('base'):
        COST[t['id']] = round(COST[t['base']] * 1.35 / 5) * 5
economy = {
    "exempt": ["gupta"],
    "income": {"town": 40, "capital": 90},
    "startGold": 300,
    "upkeep": 0.1,
    "costs": COST,
}

data = {
    "id": "rise-of-the-guptas-319",
    "name": "The Rise of the Guptas",
    "era": "India and its neighbours · from 319 CE",
    "disclaimer": "Loosely based on the founding of the Gupta empire under Chandragupta I and Samudragupta. Town positions are real; borders, armies and events are simplified or invented, and the dates of these kingdoms are uncertain (the Kadambas and Western Gangas rise a little later). The Parthian Arsacid empire had fallen to the Sasanians a century earlier; the Parthian house of Suren still held Sakastan.",
    "briefing": "Chandragupta I has taken the title Maharajadhiraja and holds Magadha, ruling from Pataliputra along the Ganga to Saketa and Prayaga. His marriage to the Licchavi princess Kumaradevi makes the Licchavis of Vaishali your allies. Around you, India is divided: the Naga kings hold Padmavati, Mathura and Vidisha; Achyuta rules Ahichchhatra; the Yaudheya, Madraka and Malava republics guard the west; the Saka satraps hold Ujjayini; the Kushans rule beyond the Indus, and west of them the Parthian lords of Sakastan; Vanga holds Bengal and the Vakatakas the Deccan. In the south, the kings Samudragupta would one day face: Mahendra of Kosala, Mahendragiri of Pishtapura, Hastivarman of Vengi, Vishnugopa of Kanchi, with the Kadambas, Gangas, Kalabhras and Cheras beyond. The other realms tax their towns and pay to raise troops; your levies cost nothing. Take every rival capital to make the Guptas paramount. Lose Pataliputra and the dynasty ends.",
    "victory": "Every rival capital bows to Pataliputra. The Guptas are paramount over India.",
    "defeat": "Pataliputra has fallen. The Gupta line ends before it began.",
    "startYear": 319,
    "player": "gupta",
    "bounds": [58.5, 7.5, 92.5, 36.5],
    "scale": 80,
    "factions": factions,
    "alliances": [["gupta", "licchavi"]],
    "economy": economy,
    "settlements": settlements,
    "roads": [list(r) for r in roads],
    "rivers": rivers, "ridge": ridge, "hills": hills, "deserts": deserts, "seas": seas,
    "armies": armies,
    "reinforcements": reinforcements,
}

# ---------------------------------------------------------------- checks
S = data["scale"]
lon0, lat1 = data["bounds"][0], data["bounds"][3]
P = lambda p: ((p[0] - lon0) * S, (lat1 - p[1]) * S)


def segd(p, a, b):
    ax, az = a
    bx, bz = b
    dx, dz = bx - ax, bz - az
    t = max(0, min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz)))
    return math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz)


def in_poly(pt, poly):
    x, y = pt
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        (xi, yi), (xj, yj) = poly[i], poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


ids = {s['id']: P(s['pos']) for s in settlements}
problems = 0
for s in settlements:
    p = ids[s['id']]
    rd = min(min(segd(p, P(r['points'][i]), P(r['points'][i + 1])) for i in range(len(r['points']) - 1)) for r in rivers)
    near = min(math.dist(p, q) for k, q in ids.items() if k != s['id'])
    sea = any(in_poly(s['pos'], poly) for poly in seas)
    if rd < 13 or near < 30 or sea:
        problems += 1
        print('CHECK', s['id'], 'river', round(rd), 'nearest town', round(near), 'IN SEA' if sea else '')
    assert s['owner'] in factions, s
for a, b in roads:
    assert a in ids and b in ids, (a, b)
for f in factions.values():
    assert f['capital'] in ids, f
    for t in f['recruits']:
        assert t in COST, t
long_roads = [(a, b, round(math.dist(ids[a], ids[b]))) for a, b in roads if math.dist(ids[a], ids[b]) > 420]
for r in long_roads:
    print('LONG ROAD', r)

json.dump(data, open(OUT, 'w', encoding='utf8'), indent=1, ensure_ascii=False)
print(len(settlements), 'towns,', len(roads), 'roads,', len(factions), 'realms,', problems, 'placement problems')
