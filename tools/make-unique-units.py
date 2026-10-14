"""Generate each kingdom's unique units from a base unit type plus buffs and debuffs.

Run from the repository root:  python tools/make-unique-units.py
Writes data/units/<id>.json. Each unique unit records its kingdom, its base type and a readable
"traits" list (what the buffs and debuffs are), which the game shows on unit cards and recruit buttons.
Edit the table below and re-run to rebalance.
"""
import copy
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')
UNITS = os.path.join(ROOT, 'data', 'units')

# path -> (label, kind): 'mul' multiplies, 'add' adds, 'range' scales every range figure of the weapon.
STATS = {
    'hp': ('men (HP)', 'mul'),
    'org': ('organization', 'mul'),
    'stamina': ('stamina', 'mul'),
    'walk': ('walking speed', 'mul'),
    'run': ('running speed', 'mul'),
    # Lower visibility is a buff: shown as concealment so the sign reads the right way.
    'visibility': ('concealment', 'mul_inv'),
    'melee.attack': ('melee attack', 'mul'),
    'melee.defense': ('melee defence', 'mul'),
    'melee.chargeBonus': ('charge', 'mul'),
    'melee.chargeResistance': ('charge resistance', 'add'),
    'melee.antiCavalry': ('resistance to horse and elephant charges', 'add'),
    'ranged.attack': ('missile damage', 'mul'),
    'ranged.ammo': ('ammunition', 'mul'),
    'ranged.range': ('missile range', 'range'),
    'orgRadiusBonus': ('steadying effect on nearby units', 'mul'),
}

# id, name, kingdom, base type, {stat: change}, note. Multipliers are written as +0.2 (= +20%).
UNIQUE = [
    ('gupta-imperial-archers', 'Imperial Archers', 'gupta', 'archers',
     {'ranged.attack': 0.2, 'ranged.range': 0.15, 'melee.defense': -0.15},
     'The archer-kings of the Gupta coins: picked bowmen with long bamboo bows. Hit harder and further, but fragile if caught.'),
    ('gupta-royal-elephants', 'Royal War Elephants', 'gupta', 'war-elephants',
     {'hp': 0.15, 'melee.attack': 0.15, 'org': 0.1, 'walk': -0.05},
     'The emperor\'s own armoured elephants. Tougher and steadier than any levy beasts, a little slower.'),
    ('licchavi-assembly-guard', 'Vajji Assembly Guard', 'licchavi', 'heavy-infantry',
     {'org': 0.25, 'stamina': 0.1, 'melee.attack': -0.1},
     'Citizen soldiers of the oldest republic: they hold together long after others would break, but hit less hard.'),
    ('vanga-river-archers', 'Vanga Boat Archers', 'vanga', 'archers',
     {'walk': 0.12, 'ranged.attack': 0.1, 'hp': -0.15},
     'Light archers of the delta, used to moving fast between boats and banks. Quick and sharp, thin in numbers.'),
    ('naga-spearmen', 'Naga Shield-Spearmen', 'naga', 'levy-spearmen',
     {'melee.defense': 0.2, 'melee.antiCavalry': 0.15, 'org': 0.1, 'walk': -0.1},
     'Disciplined spear walls of the Naga kings. Very hard to ride down, slow to move.'),
    ('panchala-swordsmen', 'Panchala Swordsmen', 'ahichchhatra', 'heavy-infantry',
     {'melee.attack': 0.18, 'melee.chargeBonus': 0.15, 'stamina': -0.15},
     'Achyuta\'s household swordsmen: savage in the first clash, they tire quickly.'),
    ('yaudheya-warriors', 'Yaudheya Warriors', 'yaudheya', 'heavy-infantry',
     {'melee.attack': 0.2, 'org': 0.12, 'melee.defense': -0.1},
     '"Victorious among warriors": the martial republic\'s sworn fighters. Aggressive and proud, lightly armoured.'),
    ('madraka-horse', 'Madraka Riders', 'madraka', 'heavy-cavalry',
     {'melee.chargeBonus': 0.2, 'walk': 0.1, 'run': 0.08, 'hp': -0.15},
     'Famed horsemen of the Punjab: fast, hard-charging, fewer in number.'),
    ('kushan-cataphracts', 'Kushan Cataphracts', 'kushan', 'steppe-lancers',
     {'hp': 0.25, 'melee.defense': 0.25, 'melee.chargeBonus': 0.15, 'run': -0.15, 'stamina': -0.15},
     'Armoured horse of the Kushan court. Nearly unstoppable in the charge, heavy and quick to tire.'),
    ('malava-guardsmen', 'Malava Guardsmen', 'malava', 'heavy-infantry',
     {'melee.defense': 0.2, 'melee.chargeResistance': 0.15, 'walk': -0.1},
     'The republic\'s shield line: very hard to break or charge down, slow to advance.'),
    ('saka-horse-archers', 'Saka Horse Archers', 'kshatrapa', 'horse-archers',
     {'ranged.attack': 0.2, 'ranged.ammo': 0.25, 'melee.defense': -0.15},
     'Steppe archers of the satraps\' own clans: deadly volleys and full quivers, poor in a melee.'),
    ('deccan-elephants', 'Deccan Elephants', 'vakataka', 'war-elephants',
     {'hp': 0.2, 'stamina': 0.15, 'walk': -0.1},
     'Big forest elephants of the Vakataka hills. Enormous staying power, slow.'),
    ('parthian-cataphracts', 'Parthian Cataphracts', 'parthian', 'steppe-lancers',
     {'hp': 0.3, 'melee.defense': 0.3, 'melee.chargeBonus': 0.2, 'walk': -0.2, 'run': -0.2, 'stamina': -0.2},
     'Horse and rider armoured head to foot. The heaviest charge in the world, and the slowest horse on the field.'),
    ('parthian-horse-archers', 'Parthian Horse Archers', 'parthian', 'horse-archers',
     {'ranged.attack': 0.15, 'run': 0.1, 'ranged.ammo': 0.3, 'hp': -0.1},
     'Masters of the Parthian shot: fast, well supplied with arrows, but too few to stand and fight.'),
    ('pallava-spearmen', 'Pallava Spearmen', 'pallava', 'levy-spearmen',
     {'melee.defense': 0.15, 'org': 0.15, 'melee.attack': 0.05, 'run': -0.1},
     'Kanchi\'s trained spearmen: solid and well led, not quick on their feet.'),
    ('vengi-archers', 'Vengi Archers', 'salankayana', 'archers',
     {'ranged.range': 0.15, 'ranged.attack': 0.08, 'hp': -0.12},
     'Archers of the Godavari delta who shoot from long range. Few and lightly protected.'),
    ('kalinga-elephants', 'Kalinga War Elephants', 'kalinga', 'war-elephants',
     {'melee.chargeBonus': 0.25, 'hp': 0.1, 'org': -0.12},
     'Kalinga\'s famous elephant corps: a crushing charge, but the beasts are skittish when hurt.'),
    ('kosala-forest-archers', 'Forest Archers of Kosala', 'kosala', 'skirmishers',
     {'visibility': -0.3, 'ranged.attack': 0.15, 'hp': -0.1},
     'Hunters from the forests of Mahakantara: very hard to spot, sharp shots, few in number.'),
    ('kadamba-swordsmen', 'Kadamba Swordsmen', 'kadamba', 'heavy-infantry',
     {'melee.attack': 0.15, 'walk': 0.06, 'melee.defense': -0.1},
     'Banavasi\'s hill swordsmen: quick, fierce and lightly armoured.'),
    ('ganga-spearmen', 'Ganga Spearmen', 'ganga', 'levy-spearmen',
     {'stamina': 0.2, 'melee.antiCavalry': 0.12, 'melee.attack': -0.08},
     'Tough spearmen of the Kolar plateau: tireless and good against horse, not strong attackers.'),
    ('kalabhra-raiders', 'Kalabhra Raiders', 'kalabhra', 'skirmishers',
     {'walk': 0.15, 'run': 0.15, 'melee.attack': 0.1, 'org': -0.15},
     'Hill raiders who overran the Tamil kingdoms: fast and bold, quick to scatter.'),
    ('chera-bowmen', 'Chera Longbowmen', 'chera', 'archers',
     {'ranged.attack': 0.15, 'ranged.range': 0.1, 'org': -0.1},
     'Bowmen of the Malabar coast with tall bows: strong shots, brittle nerve.'),
]


def get(d, path):
    for k in path.split('.'):
        d = d.get(k) if isinstance(d, dict) else None
        if d is None:
            return None
    return d


def put(d, path, v):
    ks = path.split('.')
    for k in ks[:-1]:
        d = d[k]
    d[ks[-1]] = v


def pct(x):
    return f"{'+' if x > 0 else ''}{round(x * 100)}%"


for uid, name, kingdom, base_id, mods, note in UNIQUE:
    base = json.load(open(os.path.join(UNITS, f'{base_id}.json'), encoding='utf8'))
    u = copy.deepcopy(base)
    u['id'] = uid
    u['name'] = name
    u['kingdom'] = kingdom
    u['base'] = base_id
    traits = []
    for path, change in mods.items():
        label, kind = STATS[path]
        if kind == 'range':
            w = u['ranged']['weapon']
            k = 1 + change
            w['effective'] = round(w['effective'] * k, 1)
            w['close'] = round(w['close'] * k, 1)
            w['bands'] = [[round(b[0] * k, 1), round(b[1] * k, 1), b[2], b[3]] for b in w['bands']]
            traits.append(f'{pct(change)} {label}')
            continue
        cur = get(u, path)
        if kind in ('mul', 'mul_inv'):
            if cur is None:
                raise SystemExit(f'{uid}: {path} missing on {base_id}')
            v = cur * (1 + change)
            put(u, path, round(v, 3) if isinstance(cur, float) or abs(v) < 10 else round(v))
            traits.append(f'{pct(-change if kind == "mul_inv" else change)} {label}')
        else:
            put(u, path, round((cur or 0) + change, 3))
            traits.append(f'{"+" if change > 0 else ""}{change:g} {label}')
    # Buffs first, then debuffs.
    traits.sort(key=lambda t: t.startswith('-'))
    u['traits'] = traits
    u['note'] = note
    json.dump(u, open(os.path.join(UNITS, f'{uid}.json'), 'w', encoding='utf8'), indent=2, ensure_ascii=False)
    print(f'{uid:28s} {", ".join(traits)}')
