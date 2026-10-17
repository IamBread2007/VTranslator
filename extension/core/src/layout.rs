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

fn fits(lines: &[String], caps: &[f64], font_px: f64, measure: Measure<'_>) -> bool {
    !lines.is_empty()
        && lines.len() <= caps.len()
        && lines.iter().enumerate().all(|(i, line)| {
            !too_wide(reserved_width(line, font_px, measure), caps[i])
        })
}

fn place(text: &str, box_: &Box, shape: Shape, font_px: f64, line_height: f64, measure: Measure<'_>) -> Option<Vec<String>> {
    let line_h = font_px * line_height;
    if line_h > box_.h || box_.w <= 0.0 || box_.h <= 0.0 {
        return None;
    }
    let max_lines = MAX_LINES.min((box_.h / line_h).floor().max(1.0) as usize);
    for n in 1..=max_lines {
        let caps = line_caps(box_, shape, n, font_px, line_height);
        let lines = wrap_text_caps(text, &caps, font_px, measure);
        if lines.len() <= n && fits(&lines, &caps, font_px, measure) {
            return Some(lines);
        }
    }
    None
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
