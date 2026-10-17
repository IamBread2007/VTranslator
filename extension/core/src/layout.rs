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
