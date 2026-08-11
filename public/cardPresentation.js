function amountLeft(value, unit = '') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const clamped = Math.max(0, numeric);
  const amount = clamped > 0 && clamped < 1 ? '< 1' : String(Math.round(clamped));
  return `${amount}${unit}`;
}

function countLeft(value, singular, plural) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const clamped = Math.max(0, numeric);
  const amount = clamped > 0 && clamped < 1 ? '< 1' : String(Math.round(clamped));
  const noun = amount === '1' || amount === '< 1' ? singular : plural;
  return `${amount} ${noun} Left`;
}

function servingSizeLabel(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatVolumeReadout(tap, measurement) {
  if (!measurement?.available) return 'Unavailable';
  const unit = tap?.display_unit || 'percent';
  const volumeOz = Number(measurement.volumeOz);
  const customSize = Math.max(0.5, Number.parseFloat(tap?.custom_pour_size) || 12);

  switch (unit) {
    case 'pints': {
      const pints = Number.isFinite(measurement.pintsRemaining) ? measurement.pintsRemaining : volumeOz / 16;
      return countLeft(pints, 'Pint', 'Pints') || 'Unavailable';
    }
    case 'oz': {
      const amount = amountLeft(volumeOz);
      return amount === null ? 'Unavailable' : `${amount} oz Left`;
    }
    case 'pours_12': {
      const pours = countLeft(volumeOz / 12, 'Pour', 'Pours');
      return pours ? `${pours} (12 oz)` : 'Unavailable';
    }
    case 'pours_custom': {
      const pours = countLeft(volumeOz / customSize, 'Pour', 'Pours');
      return pours ? `${pours} (${servingSizeLabel(customSize)} oz)` : 'Unavailable';
    }
    case 'percent':
    default: {
      const amount = amountLeft(measurement.fillPercent, '%');
      return amount === null ? 'Unavailable' : `${amount} Left`;
    }
  }
}

export function fitSingleLineText(element, { minScale = 0.9, getStyles = globalThis.getComputedStyle } = {}) {
  if (!element || typeof getStyles !== 'function') return 1;

  element.style.removeProperty('font-size');
  element.style.removeProperty('line-height');
  const styles = getStyles(element);
  const baseFontSize = Number.parseFloat(styles.fontSize);
  if (!Number.isFinite(baseFontSize) || element.clientWidth <= 0) return 1;

  const lineHeight = Number.parseFloat(styles.lineHeight);
  element.style.lineHeight = `${Number.isFinite(lineHeight) ? lineHeight : baseFontSize * 1.2}px`;
  const scale =
    element.scrollWidth > element.clientWidth
      ? Math.max(minScale, Math.min(1, element.clientWidth / element.scrollWidth))
      : 1;
  if (scale < 1) element.style.fontSize = `${baseFontSize * scale}px`;
  element.dataset.fitScale = scale.toFixed(3);
  return scale;
}
