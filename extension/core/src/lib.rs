mod layout;

pub use layout::*;

pub fn ink_ratio() -> f64 {
    0.72
}

#[cfg(target_arch = "wasm32")]
mod wasm_api {
    use wasm_bindgen::prelude::*;

    use crate::layout::{
        caps_from_slice_widths, fit_text, line_caps, width_at, wrap_text, wrap_text_caps, Box,
        FitOptions, Shape,
    };

    fn shape_of(name: &str) -> Shape {
        if name == "ellipse" { Shape::Ellipse } else { Shape::Rect }
    }

    /// A bad contour JSON is the rectangle fallback, not a panic.
    fn slices_of(json: &str) -> Option<Vec<f64>> {
        let parsed: Vec<f64> = serde_json::from_str(json).unwrap_or_default();
        if parsed.is_empty() { None } else { Some(parsed) }
    }

    #[wasm_bindgen(js_name = inkRatio)]
    pub fn ink_ratio_js() -> f64 {
        crate::ink_ratio()
    }

    #[wasm_bindgen(js_name = widthAt)]
    pub fn width_at_js(w: f64, h: f64, slice_json: &str, t: f64) -> f64 {
        width_at(&Box { w, h, slice_widths: slices_of(slice_json) }, t)
    }

    #[wasm_bindgen(js_name = capsFromSliceWidths)]
    pub fn caps_js(w: f64, h: f64, slice_json: &str, line_count: usize) -> Vec<f64> {
        caps_from_slice_widths(&Box { w, h, slice_widths: slices_of(slice_json) }, line_count)
    }

    #[wasm_bindgen(js_name = lineCaps)]
    pub fn line_caps_js(
        w: f64,
        h: f64,
        slice_json: &str,
        shape: &str,
        line_count: usize,
        font_px: f64,
        line_height: f64,
    ) -> Vec<f64> {
        line_caps(
            &Box { w, h, slice_widths: slices_of(slice_json) },
            shape_of(shape),
            line_count,
            font_px,
            line_height,
        )
    }

    #[wasm_bindgen(js_name = wrapText)]
    pub fn wrap_text_js(text: &str, max_width: f64, font_px: f64, measure: &js_sys::Function) -> Vec<String> {
        wrap_text(text, max_width, font_px, &|s, px| call_measure(measure, s, px))
    }

    #[wasm_bindgen(js_name = wrapTextCaps)]
    pub fn wrap_text_caps_js(
        text: &str,
        caps: &[f64],
        font_px: f64,
        measure: &js_sys::Function,
    ) -> Vec<String> {
        wrap_text_caps(text, caps, font_px, &|s, px| call_measure(measure, s, px))
    }

    #[derive(serde::Serialize)]
    struct FitOut {
        #[serde(rename = "fontPx")]
        font_px: f64,
        lines: Vec<String>,
        overflow: bool,
        #[serde(rename = "lineHeight")]
        line_height: f64,
    }

    #[wasm_bindgen(js_name = fitText)]
    pub fn fit_text_js(
        text: &str,
        w: f64,
        h: f64,
        slice_json: &str,
        measure: &js_sys::Function,
        min_px: f64,
        max_px: f64,
        line_height: f64,
        shape: &str,
    ) -> JsValue {
        let fit = fit_text(
            text,
            &Box { w, h, slice_widths: slices_of(slice_json) },
            &|s, px| call_measure(measure, s, px),
            FitOptions { min_px, max_px, line_height, shape: shape_of(shape) },
        );
        serde_wasm_bindgen::to_value(&FitOut {
            font_px: fit.font_px,
            lines: fit.lines,
            overflow: fit.overflow,
            line_height: fit.line_height,
        })
        .unwrap_or(JsValue::NULL)
    }

    /// A thrown measure is non-finite, which the fitter treats as too wide.
    fn call_measure(measure: &js_sys::Function, text: &str, font_px: f64) -> f64 {
        let this = JsValue::NULL;
        let Ok(value) = measure.call2(&this, &JsValue::from_str(text), &JsValue::from_f64(font_px)) else {
            return f64::NAN;
        };
        value.as_f64().unwrap_or(f64::NAN)
    }
}
