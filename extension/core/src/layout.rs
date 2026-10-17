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
