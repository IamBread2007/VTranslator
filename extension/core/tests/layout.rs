#[test]
fn ink_ratio_matches_the_extension() {
    assert_eq!(mt_layout::ink_ratio(), 0.72);
}

fn box_of(w: f64, h: f64, slices: Option<Vec<f64>>) -> mt_layout::Box {
    mt_layout::Box { w, h, slice_widths: slices }
}

#[test]
fn missing_profile_is_the_full_width() {
    let box_ = box_of(100.0, 40.0, None);
    assert_eq!(mt_layout::width_at(&box_, 0.5), 100.0);
    assert_eq!(mt_layout::caps_from_slice_widths(&box_, 3), vec![100.0, 100.0, 100.0]);
}

#[test]
fn hourglass_pinches_the_middle() {
    let box_ = box_of(100.0, 40.0, Some(vec![1.0, 0.4, 1.0]));
    let caps = mt_layout::caps_from_slice_widths(&box_, 3);
    assert!(caps[1] < caps[0] && caps[1] < caps[2]);
    assert!(caps.iter().all(|c| *c <= 100.0));
}

#[test]
fn samples_outside_zero_one_cannot_widen_the_box() {
    let box_ = box_of(100.0, 40.0, Some(vec![1.5, -1.0]));
    assert!(mt_layout::width_at(&box_, 0.0) <= 100.0);
    assert!(mt_layout::width_at(&box_, 1.0) >= 0.0);
}

fn mono(text: &str, px: f64) -> f64 {
    text.chars().count() as f64 * px
}

#[test]
fn wraps_on_words_and_keeps_every_character() {
    let lines = mt_layout::wrap_text("xin chào bạn", 8.0, 1.0, &mono);
    let joined = lines.join("");
    assert_eq!(joined.replace(' ', ""), "xinchàobạn");
}

#[test]
fn hangs_one_mark_and_not_a_run() {
    let one = mt_layout::wrap_text("ab.", 2.0, 1.0, &mono);
    let run = mt_layout::wrap_text("ab?!", 2.0, 1.0, &mono);
    assert_eq!(one, vec!["ab.".to_string()]);
    assert_ne!(run, vec!["ab?!".to_string()]);
}

fn opts(min_px: f64, max_px: f64) -> mt_layout::FitOptions {
    mt_layout::FitOptions { min_px, max_px, line_height: 1.2, shape: mt_layout::Shape::Rect }
}

#[test]
fn largest_size_that_fits() {
    let box_ = box_of(100.0, 40.0, None);
    let fit = mt_layout::fit_text("hello", &box_, &mono, opts(10.0, 40.0));
    assert!(!fit.overflow);
    assert!(fit.font_px >= 10.0 && fit.font_px <= 40.0);
}

#[test]
fn never_below_eight() {
    let box_ = box_of(10.0, 10.0, None);
    let fit = mt_layout::fit_text("a long sentence that cannot fit", &box_, &mono, opts(10.0, 20.0));
    assert!(fit.overflow);
    assert!(fit.font_px >= 8.0);
}

#[test]
fn degenerate_box_fails_closed() {
    let box_ = box_of(0.0, -1.0, None);
    let fit = mt_layout::fit_text("hello", &box_, &mono, opts(12.0, 20.0));
    assert!(fit.overflow);
    assert_eq!(fit.font_px, 12.0);
    assert_eq!(fit.lines, vec!["hello".to_string()]);
}

#[test]
fn empty_text_is_one_empty_line() {
    let box_ = box_of(100.0, 40.0, None);
    let fit = mt_layout::fit_text("", &box_, &mono, opts(10.0, 20.0));
    assert_eq!(fit.lines, vec!["".to_string()]);
}

#[test]
fn tall_box_stays_within_max_lines() {
    let box_ = box_of(20.0, 100_000.0, None);
    let started = std::time::Instant::now();
    let fit = mt_layout::fit_text("word ".repeat(80).trim(), &box_, &mono, opts(8.0, 12.0));
    assert!(started.elapsed().as_secs() < 1);
    assert!(fit.lines.len() <= 64);
}
