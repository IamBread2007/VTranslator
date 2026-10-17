#[derive(Clone, Debug)]
pub struct Box {
    pub w: f64,
    pub h: f64,
    pub slice_widths: Option<Vec<f64>>,
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn sample(slices: &[f64], i: usize) -> f64 {
    clamp01(slices[i])
}

/// Width at fractional height `t`. Empty profile is the rectangle.
/// Samples clamp to 0..1 so a bad contour cannot draw past the box.
pub fn width_at(box_: &Box, t: f64) -> f64 {
    let Some(slices) = box_.slice_widths.as_deref().filter(|s| !s.is_empty()) else {
        return box_.w;
    };
    if slices.len() == 1 {
        return box_.w * sample(slices, 0);
    }
    let pos = clamp01(t) * (slices.len() - 1) as f64;
    let i = (pos.floor() as usize).min(slices.len() - 2);
    let frac = pos - i as f64;
    let left = sample(slices, i);
    let right = sample(slices, i + 1);
    box_.w * (left + (right - left) * frac)
}

pub fn caps_from_slice_widths(box_: &Box, line_count: usize) -> Vec<f64> {
    (0..line_count)
        .map(|i| width_at(box_, (i as f64 + 0.5) / line_count as f64))
        .collect()
}

pub type Measure<'a> = &'a dyn Fn(&str, f64) -> f64;

const HANGING: &[char] = &['.', ',', '!', '?', '\u{2026}', ':', ';', '\u{201d}', '\u{2019}'];

fn usable(width: f64) -> bool {
    width.is_finite() && width >= 0.0
}

fn too_wide(measured: f64, cap: f64) -> bool {
    !usable(measured) || measured > cap
}

/// One trailing mark may hang. A run, or a punctuation-only line, may not.
fn reserved_width(line: &str, font_px: f64, measure: Measure<'_>) -> f64 {
    let mut chars = line.chars();
    let Some(last) = chars.next_back() else {
        return measure(line, font_px);
    };
    let kept: String = chars.collect();
    if kept.chars().count() < 1 || !HANGING.contains(&last) || kept.trim().is_empty() {
        return measure(line, font_px);
    }
    measure(&kept, font_px)
}

fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_string).collect()
}

fn wrap_with(text: &str, cap_at: &dyn Fn(usize) -> f64, font_px: f64, measure: Measure<'_>) -> Vec<String> {
    let words = tokenize(text);
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in words {
        let candidate = if cur.is_empty() { word.clone() } else { format!("{cur} {word}") };
        if !too_wide(reserved_width(&candidate, font_px, measure), cap_at(lines.len())) {
            cur = candidate;
            continue;
        }
        if !cur.is_empty() {
            lines.push(std::mem::take(&mut cur));
        }
        if !too_wide(reserved_width(&word, font_px, measure), cap_at(lines.len())) {
            cur = word;
            continue;
        }
        let mut chunk = String::new();
        for ch in word.chars() {
            let next = format!("{chunk}{ch}");
            if !chunk.is_empty() && too_wide(reserved_width(&next, font_px, measure), cap_at(lines.len())) {
                lines.push(std::mem::take(&mut chunk));
                chunk = ch.to_string();
            } else {
                chunk = next;
            }
        }
        cur = chunk;
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.is_empty() { vec![String::new()] } else { lines }
}

pub fn wrap_text(text: &str, max_width: f64, font_px: f64, measure: Measure<'_>) -> Vec<String> {
    wrap_with(text, &|_| max_width, font_px, measure)
}

pub fn wrap_text_caps(text: &str, caps: &[f64], font_px: f64, measure: Measure<'_>) -> Vec<String> {
    wrap_with(
        text,
        &|i| caps.get(i).copied().unwrap_or(0.0),
        font_px,
        measure,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Rect,
    Ellipse,
}

#[derive(Clone, Copy, Debug)]
pub struct FitOptions {
    pub min_px: f64,
    pub max_px: f64,
    pub line_height: f64,
    pub shape: Shape,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FitResult {
    pub font_px: f64,
    pub lines: Vec<String>,
    pub overflow: bool,
    pub line_height: f64,
}

const ABS_MIN_PX: f64 = 8.0;
const LH_STEP: f64 = 0.05;
const MAX_LINES: usize = 64;
const INK_RATIO: f64 = 0.72;
const MONOTONIC_PROBE_PX: i32 = 24;

pub fn line_caps(box_: &Box, shape: Shape, line_count: usize, font_px: f64, line_height: f64) -> Vec<f64> {
    if box_.slice_widths.as_ref().is_some_and(|s| !s.is_empty()) {
        return caps_from_slice_widths(box_, line_count);
    }
    if shape != Shape::Ellipse {
        return vec![box_.w; line_count];
    }
    let a = box_.w / 2.0;
    let b = box_.h / 2.0;
    let line_h = font_px * line_height;
    let ink_h = (font_px * INK_RATIO).min(line_h);
    let origin_y = (box_.h - line_count as f64 * line_h) / 2.0;
    (0..line_count)
        .map(|i| {
            let ink_top = origin_y + i as f64 * line_h + (line_h - ink_h) / 2.0;
            let ink_bottom = ink_top + ink_h;
            let dy = (ink_top - b).abs().max((ink_bottom - b).abs());
            let ratio = if b == 0.0 { 1.0 } else { (dy / b).min(1.0) };
            2.0 * a * (1.0 - ratio * ratio).max(0.0).sqrt()
        })
        .collect()
}

/// One text unit of a line: the unit plus the separator that follows it when
/// another unit joins the same line. Cutting an over-long word by characters
/// produces pieces of a *single* word, and rejoining those with spaces would
/// invent whitespace the source never had.
struct Piece {
    text: String,
    sep: String,
}

/// Badness of one completely empty line, scaling as (1 - fill)^3, and the cost
/// of bringing one more line into existence. Without the penalty the total is
/// minimised by using as many lines as possible, which yields one-word lines.
const BASE_BADNESS: f64 = 1000.0;
const LINE_PENALTY: f64 = 60.0;

/// How many line counts beyond the best one are still explored. Badness falls as
/// lines get shorter and LINE_PENALTY pushes back, so the optimum sits at or
/// just above the smallest feasible count.
const LOOKAHEAD_LINES: usize = 2;

/// Split one over-long token into pieces that each measure <= max_width.
fn chunk_token(token: &str, max_width: f64, font_px: f64, measure: Measure<'_>) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut chunk = String::new();
    for ch in token.chars() {
        let next = format!("{chunk}{ch}");
        if !chunk.is_empty() && too_wide(reserved_width(&next, font_px, measure), max_width) {
            pieces.push(std::mem::take(&mut chunk));
            chunk = ch.to_string();
        } else {
            chunk = next;
        }
    }
    if !chunk.is_empty() {
        pieces.push(chunk);
    }
    pieces
}

/// Partition `pieces` into exactly `caps.len()` lines so no line reserves more
/// than its cap, minimising total badness. A greedy pass fills each line to the
/// brim and strands the leftover on the last line; choosing the cheapest
/// partition makes the lines even, which is what a balloon needs.
fn balanced_wrap(
    pieces: &[Piece],
    caps: &[f64],
    font_px: f64,
    measure: Measure<'_>,
) -> Option<(Vec<String>, f64)> {
    let n = caps.len();
    let m = pieces.len();
    // Every line needs at least one piece, and no line may sit empty.
    if n == 0 || m == 0 || m < n {
        return None;
    }

    const INF: f64 = f64::INFINITY;
    // cost[j] = cheapest total for the first j pieces on the lines placed so far.
    let mut prev = vec![INF; m + 1];
    prev[0] = 0.0;
    // starts[k][j] = index of the first piece of line k+1 in the optimal prefix.
    let mut starts: Vec<Vec<usize>> = Vec::with_capacity(n);

    for i in 1..=n {
        let cap = caps[i - 1];
        let mut cur = vec![INF; m + 1];
        let mut start = vec![usize::MAX; m + 1];
        for j in 1..=m {
            // Line i would cover pieces [a, j); grow it backwards until it overflows.
            let mut text = String::new();
            let mut a = j;
            while a >= 1 {
                a -= 1;
                let piece = &pieces[a];
                text = if text.is_empty() {
                    piece.text.clone()
                } else {
                    format!("{}{}{}", piece.text, piece.sep, text)
                };
                let w = reserved_width(&text, font_px, measure);
                // A non-finite measure is "wider than anything", not a NaN that
                // silently propagates into the fill fraction and yields a finite
                // cost: the whole block must fail closed instead.
                if !usable(w) || w > cap {
                    break;
                }
                if !prev[a].is_finite() {
                    continue;
                }
                let fill = if cap > 0.0 { (w / cap).min(1.0) } else { 1.0 };
                let cost = prev[a] + BASE_BADNESS * (1.0 - fill).powi(3) + LINE_PENALTY;
                if cost < cur[j] {
                    cur[j] = cost;
                    start[j] = a;
                }
            }
        }
        starts.push(start);
        prev = cur;
    }

    if !prev[m].is_finite() {
        return None;
    }

    let mut lines = vec![String::new(); n];
    let mut j = m;
    for i in (1..=n).rev() {
        let a = starts[i - 1][j];
        let mut line = String::new();
        for k in a..j {
            let piece = &pieces[k];
            line = if line.is_empty() {
                piece.text.clone()
            } else {
                format!("{}{}{}", line, piece.sep, piece.text)
            };
        }
        lines[i - 1] = line;
        j = a;
    }
    Some((lines, prev[m]))
}

/// Best line break for one (fontPx, lineHeight) pair, or null when the text
/// cannot be placed at that size.
///
/// Every feasible line count is tried because the width profile depends on it:
/// spreading the text over more lines makes each line shorter and therefore more
/// likely to clear the balloon's narrowing top and bottom.
fn best_wrap(
    text: &str,
    box_: &Box,
    shape: Shape,
    font_px: f64,
    line_height: f64,
    measure: Measure<'_>,
) -> Option<Vec<String>> {
    let line_h = font_px * line_height;
    // Even a single line has to fit vertically.
    if line_h > box_.h {
        return None;
    }

    let words = tokenize(text);
    if words.is_empty() {
        return Some(vec![String::new()]);
    }

    // A word wider than the widest possible cap can never be placed, so cut it by
    // characters rather than reporting the whole block unfit. The pieces of one
    // word rejoin with no separator; only a word boundary contributes a space.
    let mut pieces: Vec<Piece> = Vec::new();
    for word in &words {
        let parts = if too_wide(measure(word, font_px), box_.w) {
            chunk_token(word, box_.w, font_px, measure)
        } else {
            vec![word.clone()]
        };
        let last = parts.len().saturating_sub(1);
        for (index, part) in parts.into_iter().enumerate() {
            pieces.push(Piece {
                text: part,
                sep: if index == last { " ".to_string() } else { String::new() },
            });
        }
    }
    if pieces.is_empty() {
        return Some(vec![String::new()]);
    }

    let max_lines = MAX_LINES
        .min((box_.h / line_h).floor().max(1.0) as usize)
        .min(pieces.len());

    // Smallest total width any partition can occupy at a given line count. Every
    // piece is paid for, and so is every separator — except that a line break
    // *removes* the separator it breaks at, so a partition with n lines keeps
    // (total separators - the n-1 it breaks at). The cheapest arrangement breaks
    // at the widest separators; each line can also hang its own final mark. Every
    // term makes the result as small as the rules allow, so this is a genuine
    // lower bound: exceeding the room available proves no partition at n lines
    // can fit, and it never skips a line count the partitioner could have used.
    let mut pieces_width = 0.0;
    let mut breakables: Vec<f64> = Vec::new();
    let mut hangers: Vec<f64> = Vec::new();
    for (k, piece) in pieces.iter().enumerate() {
        pieces_width += measure(&piece.text, font_px);
        // The final piece's separator is never rendered: nothing follows it.
        if k < pieces.len() - 1 {
            breakables.push(measure(&piece.sep, font_px));
        }
        // A line may only hang a mark that is actually there to hang, and a line
        // of punctuation alone cannot vanish, so it needs a character before the mark.
        let chars: Vec<char> = piece.text.chars().collect();
        if chars.len() > 1 {
            if let Some(mark) = chars.last() {
                if HANGING.contains(mark) {
                    hangers.push(measure(&mark.to_string(), font_px));
                }
            }
        }
    }
    let total_sep: f64 = breakables.iter().sum();
    breakables.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    hangers.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let prefix = |values: &[f64]| -> Vec<f64> {
        let mut out = Vec::with_capacity(values.len() + 1);
        out.push(0.0);
        for value in values {
            let next = out[out.len() - 1] + value;
            out.push(next);
        }
        out
    };
    // Width freed by breaking at the k widest separators, and by hanging on the k
    // widest marks.
    let removed_prefix = prefix(&breakables);
    let hang_prefix = prefix(&hangers);
    let room_for = |n: usize| -> f64 {
        pieces_width + total_sep
            - removed_prefix[(n - 1).min(breakables.len())]
            - hang_prefix[n.min(hangers.len())]
    };

    let mut best: Option<(Vec<String>, f64)> = None;
    let mut best_n = 0usize;
    for n in 1..=max_lines {
        let caps = line_caps(box_, shape, n, font_px, line_height);
        let room: f64 = caps.iter().sum();
        if room_for(n) > room {
            continue;
        }
        if best.is_some() && n > best_n + LOOKAHEAD_LINES {
            break;
        }
        if let Some((lines, cost)) = balanced_wrap(&pieces, &caps, font_px, measure) {
            if best.as_ref().map_or(true, |(_, best_cost)| cost < *best_cost) {
                best = Some((lines, cost));
                best_n = n;
            }
        }
    }
    best.map(|(lines, _)| lines)
}

fn place(text: &str, box_: &Box, shape: Shape, font_px: f64, line_height: f64, measure: Measure<'_>) -> Option<Vec<String>> {
    best_wrap(text, box_, shape, font_px, line_height, measure)
}

fn search(text: &str, box_: &Box, shape: Shape, min_px: f64, max_px: f64, lh: f64, measure: Measure<'_>) -> Option<FitResult> {
    let mut lo = min_px.ceil() as i32;
    let mut hi = max_px.floor() as i32;
    if lo > hi {
        return None;
    }
    let mut best: Option<(i32, Vec<String>)> = None;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        if let Some(lines) = place(text, box_, shape, mid as f64, lh, measure) {
            best = Some((mid, lines));
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    let (mut px, mut lines) = best?;
    let ceiling = max_px.floor() as i32;
    let probe_to = ceiling.min(px + MONOTONIC_PROBE_PX);
    for next in (px + 1)..=probe_to {
        if let Some(found) = place(text, box_, shape, next as f64, lh, measure) {
            px = next;
            lines = found;
        }
    }
    Some(FitResult { font_px: px as f64, lines, overflow: false, line_height: lh })
}

pub fn fit_text(text: &str, box_: &Box, measure: Measure<'_>, opts: FitOptions) -> FitResult {
    if box_.w <= 0.0 || box_.h <= 0.0 {
        return FitResult {
            font_px: opts.min_px,
            lines: vec![text.to_string()],
            overflow: true,
            line_height: opts.line_height,
        };
    }
    let mut ladder = vec![opts.line_height];
    while *ladder.last().unwrap() > 1.0 {
        let next = (ladder.last().unwrap() - LH_STEP).max(1.0);
        let next = (next * 100.0).round() / 100.0;
        ladder.push(next);
    }
    for lh in &ladder {
        if let Some(hit) = search(text, box_, opts.shape, opts.min_px, opts.max_px, *lh, measure) {
            return hit;
        }
    }
    let tightened = *ladder.last().unwrap();
    if opts.min_px - 1.0 >= ABS_MIN_PX {
        if let Some(hit) = search(text, box_, opts.shape, ABS_MIN_PX, opts.min_px - 1.0, tightened, measure) {
            return hit;
        }
    }
    let mut lines = wrap_text(text, box_.w, opts.min_px, measure);
    // MAX_LINES bounds the search. The overflow fallback must not ignore it.
    if lines.len() > MAX_LINES {
        let tail = lines.split_off(MAX_LINES);
        if let Some(last) = lines.last_mut() {
            last.push(' ');
            last.push_str(&tail.join(" "));
        }
    }
    FitResult {
        font_px: opts.min_px,
        lines,
        overflow: true,
        line_height: opts.line_height,
    }
}
