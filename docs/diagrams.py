"""Generates the diagrams in the npm READMEs as plain SVG, styled like docs/human-card.svg.

    python3 docs/diagrams.py docs
"""
import sys
from html import escape

OUT = sys.argv[1]
SANS = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif'
MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

STYLE = f"""  <style>
    .bg {{ fill: #ffffff; stroke: #d0d7de; }}
    .box {{ fill: #f6f8fa; stroke: #d0d7de; }}
    .key {{ fill: #ddf4ff; stroke: #54aeff; }}
    .good {{ fill: #dafbe1; stroke: #4ac26b; }}
    .bad {{ fill: #ffebe9; stroke: #ff8182; }}
    .warn {{ fill: #fff8c5; stroke: #d4a72c; }}
    .band {{ fill: #f6f8fa; stroke: none; }}
    .life {{ stroke: #d0d7de; stroke-dasharray: 4 4; }}
    .line {{ stroke: #59636e; stroke-width: 1.4; fill: none; }}
    .reply {{ stroke: #59636e; stroke-width: 1.4; fill: none; stroke-dasharray: 5 4; }}
    .head {{ fill: #59636e; }}
    .title {{ font: 600 14px {SANS}; fill: #1f2328; }}
    .text {{ font: 13px {SANS}; fill: #1f2328; }}
    .small {{ font: 12px {SANS}; fill: #1f2328; }}
    .muted {{ font: 12px {SANS}; fill: #59636e; }}
    .label {{ font: 600 11px {SANS}; fill: #59636e; letter-spacing: 0.06em; }}
    .mono {{ font: 12px {MONO}; fill: #1f2328; }}
    @media (prefers-color-scheme: dark) {{
      .bg {{ fill: #0d1117; stroke: #3d444d; }}
      .box, .band {{ fill: #151b23; stroke: #3d444d; }}
      .band {{ stroke: none; }}
      .key {{ fill: #0c2d6b; stroke: #1f6feb; }}
      .good {{ fill: #04260f; stroke: #2ea043; }}
      .bad {{ fill: #3c0b0b; stroke: #da3633; }}
      .warn {{ fill: #2e2101; stroke: #9e6a03; }}
      .life {{ stroke: #3d444d; }}
      .line, .reply {{ stroke: #9198a1; }}
      .head {{ fill: #9198a1; }}
      .title, .text, .small, .mono {{ fill: #f0f6fc; }}
      .muted, .label {{ fill: #9198a1; }}
    }}
  </style>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="head" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>"""


class Svg:
    def __init__(self, w, h, label):
        self.w, self.h, self.label, self.parts = w, h, label, []

    def add(self, s):
        self.parts.append("  " + s)

    def text(self, x, y, s, cls="text", anchor="start"):
        a = "" if anchor == "start" else f' text-anchor="{anchor}"'
        self.add(f'<text class="{cls}" x="{x}" y="{y}"{a}>{escape(s)}</text>')

    def box(self, x, y, w, h, lines, cls="box", title=None, center=False, size=13):
        """lines: list of (text, css class) or str."""
        self.add(f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>')
        tx = x + w / 2 if center else x + 14
        anchor = "middle" if center else "start"
        ty = y + 22
        if title:
            self.text(tx, ty, title, "title", anchor)
            ty += 20
        for line in lines:
            s, c = (line, "small") if isinstance(line, str) else line
            self.text(tx, ty, s, c, anchor)
            ty += 18

    def arrow(self, x1, y1, x2, y2, label=None, dashed=False, lx=None, ly=None, anchor="middle"):
        cls = "reply" if dashed else "line"
        self.add(f'<line class="{cls}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" marker-end="url(#arrow)"/>')
        if label:
            self.text(lx if lx is not None else (x1 + x2) / 2, ly if ly is not None else (y1 + y2) / 2 - 7, label, "muted", anchor)

    def path(self, d, label=None, lx=0, ly=0, anchor="start"):
        self.add(f'<path class="line" d="{d}" marker-end="url(#arrow)"/>')
        if label:
            self.text(lx, ly, label, "muted", anchor)

    def write(self, name):
        body = "\n".join(self.parts)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" role="img" aria-label="{escape(self.label)}">\n'
               f"{STYLE}\n\n  <rect class=\"bg\" x=\"0.5\" y=\"0.5\" width=\"{self.w - 1}\" height=\"{self.h - 1}\" rx=\"12\"/>\n{body}\n</svg>\n")
        open(f"{OUT}/{name}", "w").write(svg)


# ---- 1. two-phase commit with a human vote ----
s = Svg(800, 560, "Sequence: in phase 1 the airline holds a seat, payments checks the card, and the approver signs the plan digest through the Human Gateway; the coordinator logs COMMIT; in phase 2 the card is charged first and the seat hold is ticketed last")
cols = {"C": (90, "Coordinator", ""), "A": (250, "Airline", "hold"), "P": (405, "Payments", "final"), "G": (565, "Human Gateway", ""), "H": (715, "Approver", "")}
for x, name, tier in cols.values():
    s.add(f'<line class="life" x1="{x}" y1="64" x2="{x}" y2="540"/>')
for x, name, tier in cols.values():
    s.box(x - 62, 18, 124, 46 if tier else 38, [(f"tier: {tier}", "muted")] if tier else [], "key" if name in ("Approver",) else "box", title=name, center=True)
s.add('<rect class="band" x="16" y="80" width="768" height="296" rx="8"/>')
s.text(28, 100, "PHASE 1 · PREPARE — NOTHING IRREVERSIBLE HAPPENS", "label")
msgs = [
    ("C", "A", "prepare(plan, digest)", False),
    ("A", "C", "yes · seat held until its lease ends", True),
    ("C", "P", "prepare(plan, digest)", False),
    ("P", "C", "yes · card checked, not charged", True),
    ("C", "G", "prepare(plan, digest)", False),
    ("G", "H", "ask, rendered from the plan", False),
    ("H", "G", "approve (passkey)", True),
    ("G", "C", "yes + approval signed over the digest", True),
]
y = 128
for a, b, label, dashed in msgs:
    x1, x2 = cols[a][0], cols[b][0]
    pad = 4 if x2 > x1 else -4
    lx = min(x1, x2) + 10
    s.arrow(x1 + pad, y, x2 - pad, y, label, dashed, lx=lx, ly=y - 7, anchor="start")
    y += 31
s.box(28, 388, 250, 34, [("log COMMIT durably", "title")], "warn")
s.add('<rect class="band" x="16" y="436" width="768" height="104" rx="8"/>')
s.text(28, 456, "PHASE 2 · COMMIT — IRREVERSIBLE STEP FIRST, HOLDS LAST", "label")
s.arrow(94, 488, 401, 488, "commit · card charged", lx=104, ly=481, anchor="start")
s.arrow(94, 522, 246, 522, "commit · hold becomes a ticket", lx=104, ly=515, anchor="start")
s.write("two-phase.svg")


# ---- 2. choosing the prepare order ----
s = Svg(800, 470, "Flowchart: a plan with holds and approvals either sets prepareOrder, which is used as is, or the coordinator chooses parallel or approval-first from quotes and escalation estimates. Parallel tightens deadlines to each hold's horizon; approval-first has humans approve quotes before holds are placed; holds-first places holds first and signs their ends and a fitted deadline into the plan.")
s.box(250, 18, 300, 38, [("Plan has holds and approvals", "title")], "key", center=True)
s.box(20, 90, 500, 92, ["Quote each hold (maxHoldSeconds) and estimate each approval", "group's worst case along its escalation chain.", ("Slowest group fits inside the shortest hold − reserve?", "text")], title="prepareOrder not set: the coordinator chooses")
s.box(540, 90, 240, 92, ["Used as is, never overridden.", ("Any of the three modes.", "muted")], title="prepareOrder set in the plan")
s.path("M 330 56 L 270 90", None)
s.path("M 470 56 L 620 90", None)
cols3 = [
    (20, "parallel", ["Hold and ask at the same time.", "Each hold vote reports its", "horizon; waiting deadlines are", "tightened to horizon − reserve.", "Holds renewed while waiting."]),
    (280, "approval-first", ["Quote holds; none placed yet.", "The human approves the", "quoted amounts.", "Then holds are placed; a price", "past tolerance aborts."]),
    (540, "holds-first", ["Place every hold first.", "Sign each hold's end and a", "decideBy fitted inside it", "(and escalateBy) into the plan.", "Too tight to decide? Abort first."]),
]
for x, title, lines in cols3:
    s.box(x, 236, 240, 152, lines, "good" if title == "holds-first" else "box", title=title)
s.arrow(140, 182, 140, 236, "fits", lx=150, ly=214, anchor="start")
s.arrow(400, 182, 400, 236, "doesn't fit", lx=410, ly=214, anchor="start")
s.arrow(660, 182, 660, 236)
s.text(20, 418, "reserve = commit time + safety margin + escalation lead time (when the plan has a final step).", "muted")
s.text(20, 440, "The chosen order is part of the plan the human signs; in holds-first, so are the hold ends and the fitted deadline.", "muted")
s.write("prepare-order.svg")


# ---- 3. a final step in doubt, and what happens after escalation ----
s = Svg(800, 560, "Flowchart: when the final step gets no answer the transaction is IN_DOUBT; holds stay live while the commit is retried. A result leads to COMMITTED, an HATP error to a roll-back, and no answer by the escalation time to NEEDS_ATTENTION. The coordinator then keeps asking slowly, records any late outcome with each hold's state, and offers recovery options it never performs itself.")
s.box(20, 18, 230, 64, ["commit sent, no answer", "(timeout, lost connection)"], "bad", title="Final step")
s.box(290, 18, 490, 64, ["Holds stay live and are renewed. The idempotent commit", "is retried with backoff; a retry doubles as a status query."], "warn", title="IN_DOUBT: capture or void would each be a guess")
s.arrow(250, 50, 290, 50)
s.box(20, 130, 240, 64, ["Capture the holds."], "good", title="Answers with a result")
s.box(280, 130, 240, 64, ["Compensate, release holds."], "box", title="Answers with an HATP error")
s.box(540, 130, 240, 82, ["Holds left live. A human has", "leadSeconds to capture or void."], "bad", title="No answer at escalation time")
s.path("M 400 82 L 140 130")
s.path("M 470 82 L 400 130")
s.path("M 600 82 L 660 130")
s.text(140, 214, "→ COMMITTED", "mono", "middle")
s.text(400, 214, "→ ABORTED", "mono", "middle")
s.text(660, 232, "→ NEEDS_ATTENTION", "mono", "middle")
s.box(540, 262, 240, 64, ["until a definite answer, or", "give-up time."], "box", title="Keep asking, slowly")
s.arrow(660, 240, 660, 262)
s.box(20, 262, 480, 64, ["committed / failed / unknown, plus each hold: live or lapsed.", "Hash-chained and signed into an updated Transaction Record."], "key", title="Record the late outcome")
s.arrow(540, 294, 500, 294)
s.add('<rect class="box" x="20" y="366" width="760" height="130" rx="8"/>')
s.text(34, 390, "OFFERED TO A HUMAN, NEVER PERFORMED BY THE COORDINATOR", "label")
s.arrow(260, 326, 260, 366)
chips = [
    (34, "capture-holds", ["final step happened,", "holds still live"]),
    (220, "linked-transaction", ["holds lapsed: a new", "transaction with its own", "approval (recoveryOf)"]),
    (406, "undo-final", ["the provider can void", "(e.g. same-day void)"]),
    (592, "roll-back", ["final step did not", "happen: compensate,", "release holds"]),
]
for x, title, lines in chips:
    s.box(x, 402, 174, 84, lines, "good" if title == "capture-holds" else "box", title=title)
s.text(20, 520, "Escalation time = earliest hold end − leadSeconds − commit time − margin. Re-authorizing a lapsed card is merchant", "muted")
s.text(20, 540, "initiated: unless the plan records off-session consent that covers the amount, the payer has to be brought back.", "muted")
s.write("in-doubt.svg")
