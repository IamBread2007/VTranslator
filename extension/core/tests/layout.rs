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
