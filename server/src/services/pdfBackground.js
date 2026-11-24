// Complex PDF Background Classification, Reconstruction, and Visual Artifact Validation.
// Uses @napi-rs/canvas pixel sampling around target text bounding boxes to classify
// backgrounds into 8 categories, reconstruct uniform colored and gradient backgrounds
// accurately without white rectangles, and safely reject complex photographic/illustrated
// backgrounds when reliable restoration cannot be guaranteed.
import { createCanvas } from '@napi-rs/canvas';

export const BACKGROUND_TYPES = [
  'uniform_white',
  'uniform_colored',
  'simple_gradient',
  'textured',
  'photographic',
  'illustrated_or_graphical',
  'scanned_document',
  'mixed_text_and_image',
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function getPixel(imageData, width, height, x, y) {
  const cx = clamp(Math.round(x), 0, width - 1);
  const cy = clamp(Math.round(y), 0, height - 1);
  const idx = (cy * width + cx) * 4;
  return {
    r: imageData[idx],
    g: imageData[idx + 1],
    b: imageData[idx + 2],
  };
}

function sampleStrip(imageData, width, height, x0, y0, x1, y1, samples = 24) {
  const pts = [];
  const steps = Math.max(2, samples);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    pts.push(getPixel(imageData, width, height, x, y));
  }
  return pts;
}

function statsOfPixels(pixels) {
  if (!pixels.length) {
    return { mean: { r: 255, g: 255, b: 255 }, stddev: 0, localNoise: 0 };
  }
  let sr = 0; let sg = 0; let sb = 0;
  for (const p of pixels) { sr += p.r; sg += p.g; sb += p.b; }
  const n = pixels.length;
  const mean = { r: sr / n, g: sg / n, b: sb / n };

  let varSum = 0;
  let noiseSum = 0;
  for (let i = 0; i < n; i++) {
    const p = pixels[i];
    varSum += ((p.r - mean.r) ** 2 + (p.g - mean.g) ** 2 + (p.b - mean.b) ** 2) / 3;
    if (i > 0) {
      const prev = pixels[i - 1];
      noiseSum += (Math.abs(p.r - prev.r) + Math.abs(p.g - prev.g) + Math.abs(p.b - prev.b)) / 3;
    }
  }
  return {
    mean: { r: Math.round(mean.r), g: Math.round(mean.g), b: Math.round(mean.b) },
    stddev: Math.round(Math.sqrt(varSum / n) * 100) / 100,
    localNoise: n > 1 ? Math.round((noiseSum / (n - 1)) * 100) / 100 : 0,
  };
}

function colorDist(a, b) {
  return Math.round(Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) * 100) / 100;
}

export function pdfBboxToCanvasRect(pdfBbox, pageHeight, scale) {
  const px = Math.floor(pdfBbox.x * scale);
  const py = Math.floor((pageHeight - (pdfBbox.y + pdfBbox.height)) * scale);
  const pw = Math.max(2, Math.ceil(pdfBbox.width * scale));
  const ph = Math.max(2, Math.ceil(pdfBbox.height * scale));
  return { px, py, pw, ph };
}

// Classify the background immediately surrounding a text bounding box on a rendered PDF page.
export function classifyRegionBackground(canvasRender, pdfBbox, pageHeight, scale = 1.0, {
  pageHasImages = false,
  isScanned = false,
} = {}) {
  const { width, height, imageData } = canvasRender;
  const { px, py, pw, ph } = pdfBboxToCanvasRect(pdfBbox, pageHeight, scale);
  const ring = Math.max(2, Math.round(3 * scale));

  const topStrip = sampleStrip(imageData, width, height, px, py - ring, px + pw, py - ring);
  const bottomStrip = sampleStrip(imageData, width, height, px, py + ph + ring, px + pw, py + ph + ring);
  const leftStrip = sampleStrip(imageData, width, height, px - ring, py, px - ring, py + ph);
  const rightStrip = sampleStrip(imageData, width, height, px + pw + ring, py, px + pw + ring, py + ph);

  const topStats = statsOfPixels(topStrip);
  const bottomStats = statsOfPixels(bottomStrip);
  const leftStats = statsOfPixels(leftStrip);
  const rightStats = statsOfPixels(rightStrip);
  const allStats = statsOfPixels([...topStrip, ...bottomStrip, ...leftStrip, ...rightStrip]);

  const gradV = colorDist(topStats.mean, bottomStats.mean);
  const gradH = colorDist(leftStats.mean, rightStats.mean);
  const maxGrad = Math.max(gradV, gradH);
  const maxEdgeNoise = Math.max(topStats.localNoise, bottomStats.localNoise, leftStats.localNoise, rightStats.localNoise);
  const avgEdgeNoise = (topStats.localNoise + bottomStats.localNoise + leftStats.localNoise + rightStats.localNoise) / 4;

  let type = 'uniform_white';
  let safeToRestore = true;
  let reason = 'Uniform white background can be cleanly restored.';

  if (isScanned) {
    type = 'scanned_document';
    safeToRestore = false;
    reason = 'Scanned document background contains paper grain/artifacts; in-place patching is disabled to preserve visual fidelity.';
  } else if (maxGrad >= 5 && avgEdgeNoise <= 6 && allStats.stddev > 1.5 && Math.min(topStats.stddev, bottomStats.stddev, leftStats.stddev, rightStats.stddev) <= 12) {
    type = 'simple_gradient';
    safeToRestore = true;
    reason = 'Smooth directional gradient background can be interpolated between sampled edges.';
  } else if (allStats.stddev <= 4 && avgEdgeNoise <= 2.5) {
    const m = allStats.mean;
    if (m.r >= 245 && m.g >= 245 && m.b >= 245) {
      type = 'uniform_white';
      safeToRestore = true;
      reason = 'Uniform white background.';
    } else {
      type = 'uniform_colored';
      safeToRestore = true;
      reason = `Uniform colored background rgb(${m.r},${m.g},${m.b}) can be matched accurately without white patches.`;
    }
  } else if (pageHasImages && allStats.stddev >= 28 && avgEdgeNoise >= 12) {
    type = 'photographic';
    safeToRestore = false;
    reason = 'Photographic background with high color variance cannot be reconstructed pixel-identically without artifacts.';
  } else if (pageHasImages && allStats.stddev >= 14) {
    type = 'mixed_text_and_image';
    safeToRestore = false;
    reason = 'Mixed image and text background detected; rejecting automatic replacement to protect underlying imagery.';
  } else if (maxEdgeNoise >= 8 && allStats.stddev >= 18) {
    type = 'illustrated_or_graphical';
    safeToRestore = false;
    reason = 'Illustrated or graphical background elements behind text; rejecting automatic patch to avoid damaging graphics.';
  } else {
    type = 'textured';
    safeToRestore = false;
    reason = 'Textured background detected; rejecting automatic patch to avoid visible texture mismatch.';
  }

  return {
    type,
    safe_to_restore: safeToRestore,
    mean_color: allStats.mean,
    edge_colors: {
      top: topStats.mean,
      bottom: bottomStats.mean,
      left: leftStats.mean,
      right: rightStats.mean,
    },
    gradient_direction: gradV >= gradH ? 'vertical' : 'horizontal',
    variance: allStats.stddev,
    texture_energy: Math.round(avgEdgeNoise * 100) / 100,
    reason,
  };
}

// Reconstruct a clean background restoration payload for safe background types:
// - uniform_white / uniform_colored -> exact RGB fill (never white on colored!)
// - simple_gradient -> smooth interpolated PNG gradient patch matching edge colors & direction
// - complex backgrounds -> rejected by default; optional non-destructive bilinear preview
//   only when explicitly opted-in AND quality threshold passes (never alters logos/photos silently).
export function buildBackgroundRestoration(classification, {
  widthPt,
  heightPt,
  scale = 2.0,
  allowOptionalPreview = false,
  qualityThreshold = 0.78,
} = {}) {
  if (!classification?.safe_to_restore) {
    if (!allowOptionalPreview) {
      return {
        restorable: false,
        mode: 'rejected',
        background_type: classification?.type || 'unknown',
        reason: classification?.reason || 'Background cannot be reliably reconstructed.',
      };
    }

    // Optional controlled non-destructive local interpolation preview (never generative hallucination)
    // Estimate quality score from edge variance & texture energy; reject if below threshold.
    const variancePenalty = Math.min(1, (classification.variance || 0) / 60);
    const noisePenalty = Math.min(1, (classification.texture_energy || 0) / 30);
    const qualityScore = Math.round(Math.max(0, 1 - (0.55 * variancePenalty + 0.45 * noisePenalty)) * 100) / 100;

    if (qualityScore < qualityThreshold || classification.type === 'photographic' || classification.type === 'illustrated_or_graphical' || classification.type === 'scanned_document') {
      return {
        restorable: false,
        mode: 'preview_rejected_low_quality',
        background_type: classification.type,
        quality_score: qualityScore,
        quality_threshold: qualityThreshold,
        reason: `Pratinjau restorasi lokal ditolak (skor kualitas ${qualityScore} < ${qualityThreshold}) untuk melindungi keaslian foto/ilustrasi/pindaian.`,
      };
    }

    const pw = Math.max(4, Math.ceil(widthPt * scale));
    const ph = Math.max(4, Math.ceil(heightPt * scale));
    const canvas = createCanvas(pw, ph);
    const ctx = canvas.getContext('2d');
    const { top, bottom } = classification.edge_colors;
    const grad = ctx.createLinearGradient(0, 0, 0, ph);
    grad.addColorStop(0, `rgb(${top.r},${top.g},${top.b})`);
    grad.addColorStop(1, `rgb(${bottom.r},${bottom.g},${bottom.b})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, pw, ph);

    return {
      restorable: true,
      mode: 'optional_local_interpolation_preview',
      background_type: classification.type,
      quality_score: qualityScore,
      pngBuffer: canvas.toBuffer('image/png'),
      note: 'Pratinjau restorasi lokal non-destruktif; tidak menjamin rekonstruksi piksel identik.',
    };
  }

  if (classification.type === 'uniform_white' || classification.type === 'uniform_colored') {
    const { r, g, b } = classification.mean_color;
    return {
      restorable: true,
      mode: 'solid_color',
      background_type: classification.type,
      color: { r: r / 255, g: g / 255, b: b / 255 },
      rgb255: { r, g, b },
    };
  }

  if (classification.type === 'simple_gradient') {
    const pw = Math.max(4, Math.ceil(widthPt * scale));
    const ph = Math.max(4, Math.ceil(heightPt * scale));
    const canvas = createCanvas(pw, ph);
    const ctx = canvas.getContext('2d');
    const { top, bottom, left, right } = classification.edge_colors;
    const isVert = classification.gradient_direction === 'vertical';
    const grad = isVert
      ? ctx.createLinearGradient(0, 0, 0, ph)
      : ctx.createLinearGradient(0, 0, pw, 0);
    const startC = isVert ? top : left;
    const endC = isVert ? bottom : right;
    grad.addColorStop(0, `rgb(${startC.r},${startC.g},${startC.b})`);
    grad.addColorStop(1, `rgb(${endC.r},${endC.g},${endC.b})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, pw, ph);

    return {
      restorable: true,
      mode: 'gradient_patch_png',
      background_type: 'simple_gradient',
      gradient_direction: classification.gradient_direction,
      pngBuffer: canvas.toBuffer('image/png'),
    };
  }

  return {
    restorable: false,
    mode: 'rejected',
    background_type: classification.type,
    reason: 'Unsupported background type for automatic restoration.',
  };
}

// Validate a modified rendered page against the original around edited bounding boxes
// to ensure no white patch artifacts or unintended color shifts occurred outside the target region.
export function validateBackgroundRestoration(origRender, modRender, editedBboxes = [], pageHeight, scale = 1.0) {
  const issues = [];
  for (const item of editedBboxes) {
    const { px, py, pw, ph } = pdfBboxToCanvasRect(item.bbox, pageHeight, scale);
    const ring = Math.max(2, Math.round(3 * scale));

    // Sample interior background corners & surrounding border
    const origBorder = statsOfPixels([
      ...sampleStrip(origRender.imageData, origRender.width, origRender.height, px, py - ring, px + pw, py - ring, 12),
      ...sampleStrip(origRender.imageData, origRender.width, origRender.height, px, py + ph + ring, px + pw, py + ph + ring, 12),
    ]);
    const modBorder = statsOfPixels([
      ...sampleStrip(modRender.imageData, modRender.width, modRender.height, px, py - ring, px + pw, py - ring, 12),
      ...sampleStrip(modRender.imageData, modRender.width, modRender.height, px, py + ph + ring, px + pw, py + ph + ring, 12),
    ]);

    const borderShift = colorDist(origBorder.mean, modBorder.mean);
    if (borderShift > 25) {
      issues.push({
        region_id: item.region_id,
        type: 'border_color_shift',
        border_shift: borderShift,
        message: 'Perubahan warna terdeteksi di luar batas area teks yang disunting.',
      });
    }

    // Check for white-patch artifact on non-white background
    const origIsColored = origBorder.mean.r < 235 || origBorder.mean.g < 235 || origBorder.mean.b < 235;
    if (origIsColored) {
      const modCenterTop = getPixel(modRender.imageData, modRender.width, modRender.height, px + pw / 2, py + 1);
      if (modCenterTop.r > 248 && modCenterTop.g > 248 && modCenterTop.b > 248) {
        issues.push({
          region_id: item.region_id,
          type: 'white_patch_artifact',
          message: 'Artefak kotak putih terdeteksi pada latar belakang berwarna.',
        });
      }
    }
  }

  return {
    passed: issues.length === 0,
    artifact_count: issues.length,
    issues,
  };
}
