"""
Независимая сверка ходов русских шашек: pydraughts (другая реализация
правил, MIT, https://github.com/AttackingOrDefending/pydraughts).

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pydraughts==0.6.7
    node tools/checkers-positions.mjs > /tmp/pos.json
    /tmp/v/bin/python3 tools/checkers-oracle.py /tmp/pos.json > bot/checkers.oracle.json

Для каждой позиции pydraughts считает: сколько разных позиций получается за
один ход (`moves`), за два (`p2`) и отпечаток списка позиций после хода
(`kids`). Ходы, которые бьют одни и те же шашки и кончаются на одном поле,
дают одну позицию — и считаются одним ходом (у pydraughts они идут
отдельно; см. docs/checkers.md, «Один ход или два»).
"""
import sys, json, hashlib
from draughts import Board

def norm(fen):
    t, w, b = fen.split(':')
    side = lambda s: ','.join(sorted(s[1:].split(','))) if len(s) > 1 else ''
    return f"{t.upper()}:W{side(w)}:B{side(b)}"

def kids(fen):
    bd = Board(variant='russian', fen=fen)
    out = {}
    for m in bd.legal_moves():
        bd.push(m); out[norm(bd.fen)] = bd.fen; bd.pop()
    return out

with open(sys.argv[1]) as f:
    fens = json.load(f)
rows = []
for fen in fens:
    k = kids(fen)
    p2 = sum(len(kids(child)) for child in k.values())
    digest = hashlib.sha1('|'.join(sorted(k)).encode()).hexdigest()[:16]
    rows.append({'fen': fen, 'moves': len(k), 'p2': p2, 'kids': digest})
print(json.dumps({'source': 'pydraughts 0.6.7, variant=russian', 'positions': rows}, ensure_ascii=False, indent=0))
