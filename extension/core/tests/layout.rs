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
fn a_bad_measure_cannot_pick_an_unbounded_font() {
    let box_ = box_of(100.0, 40.0, None);
    let fit = mt_layout::fit_text("hello", &box_, &|_, _| f64::NAN, opts(10.0, 20.0));
    assert!(fit.overflow);
}

#[test]
fn tall_box_stays_within_max_lines() {
    let box_ = box_of(20.0, 100_000.0, None);
    let started = std::time::Instant::now();
    let fit = mt_layout::fit_text("word ".repeat(80).trim(), &box_, &mono, opts(8.0, 12.0));
    assert!(started.elapsed().as_secs() < 1);
    assert!(fit.lines.len() <= 64);
}

/// The vitest measure: half a pixel per character per px of font size.
fn half(text: &str, px: f64) -> f64 {
    text.chars().count() as f64 * px * 0.5
}

#[test]
fn balanced_wrap_leaves_no_one_word_final_line() {
    let text = "Anh không cần phải lo lắng về chuyện đó đâu";
    let box_ = box_of(95.0, 66.0, None);
    let fit = mt_layout::fit_text(text, &box_, &half, opts(8.0, 64.0));
    assert!(!fit.overflow);
    let last = fit.lines.last().unwrap();
    assert!(last.split(' ').count() > 1, "widowed final line: {:?}", fit.lines);
}

#[test]
fn balanced_wrap_never_widens_the_final_line_past_the_cap() {
    let box_ = box_of(110.0, 55.0, None);
    let fit = mt_layout::fit_text(
        "Chúng ta phải rời khỏi đây ngay lập tức",
        &box_,
        &half,
        opts(8.0, 64.0),
    );
    let widest = fit.lines.iter().map(|l| half(l, fit.font_px)).fold(0.0, f64::max);
    assert!(widest <= 110.0, "final line widened to {widest}");
}

#[test]
fn balanced_wrap_keeps_every_character() {
    let cases = [
        ("AAAAAAAAAAAAAAAAAAAAAAAA", 120.0, 120.0),
        ("iiiiiiiiiiiiiiiiiiiiiiiiiiiiii", 150.0, 90.0),
        ("một hai ba bốn năm sáu bảy tám chín mười", 100.0, 60.0),
        ("Tôi... không hiểu?!", 100.0, 60.0),
    ];
    for (text, w, h) in cases {
        let fit = mt_layout::fit_text(text, &box_of(w, h, None), &half, opts(8.0, 64.0));
        let joined: String = fit.lines.join("");
        let strip = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(strip(&joined), strip(text), "text={text:?} lines={:?}", fit.lines);
    }
}

#[test]
fn balanced_wrap_agrees_with_a_brute_force_scan() {
    for (text, w, h, min_px, max_px) in [
        ("Chuyện này thật sự rất khó tin và phức tạp", 100.0, 60.0, 8.0, 40.0),
        ("AA BB CC DD EE FF GG HH", 150.0, 90.0, 8.0, 40.0),
        (&"chữ ".repeat(60), 120.0, 120.0, 8.0, 30.0),
    ] {
        let box_ = box_of(w, h, None);
        let fit = mt_layout::fit_text(&text, &box_, &half, opts(min_px, max_px));
        if fit.overflow {
            continue;
        }
        let mut brute = 0.0;
        let mut px = min_px;
        while px <= max_px {
            let pinned = mt_layout::fit_text(
                &text,
                &box_,
                &half,
                mt_layout::FitOptions { min_px: px, max_px: px, line_height: fit.line_height, shape: mt_layout::Shape::Rect },
            );
            if !pinned.overflow && pinned.font_px == px && pinned.line_height == fit.line_height {
                brute = px;
            }
            px += 1.0;
        }
        assert_eq!(fit.font_px, brute, "text={text:.24?} lh={}", fit.line_height);
    }
}
