/**
 * TAP BOARD GRAPHICS ENGINE (graphics.js) - v3.7
 * Dynamic SVG vector renderer for Corny Kegs & 6 Beer Glassware styles.
 * Features:
 * - Full 1-50 SRM color palette interpolation (Stouts, Porters, Dark Ales, Lagers)
 * - Transparent liquid rendering for Water / Topo Chico / Seltzer
 * - Half-speed effervescent carbonation bubble generator
 */

// Full SRM to Hex Color conversion lookup table (1-50 SRM)
const SRM_COLORS = {
  0: "WATER",
  1: "#F8F753",
  2: "#F6F513",
  3: "#ECE61A",
  4: "#D5BC00",
  5: "#BF9200",
  6: "#BF8100",
  7: "#BC6800",
  8: "#B55300",
  9: "#B34700",
  10: "#A73D00",
  11: "#9C3200",
  12: "#962D00",
  13: "#8C2400",
  14: "#801C00",
  15: "#781900",
  16: "#701600",
  17: "#681300",
  18: "#601100",
  19: "#580E00",
  20: "#530C00",
  21: "#4E0B00",
  22: "#480A00",
  23: "#420900",
  24: "#3C0800",
  25: "#380600",
  26: "#340500",
  27: "#300400",
  28: "#2C0300",
  29: "#2A0300",
  30: "#280200",
  31: "#250200",
  32: "#220200",
  33: "#200100",
  34: "#1E0100",
  35: "#1D0100",
  36: "#1B0100",
  37: "#190100",
  38: "#170100",
  39: "#150100",
  40: "#130100",
  45: "#0B0100",
  50: "#080100"
};

export function srmToHex(srmVal, fallbackHex = null) {
  if (typeof fallbackHex === 'string' && fallbackHex.toUpperCase() === 'WATER') {
    return 'WATER';
  }
  if (typeof fallbackHex === 'string' && /^#[0-9a-f]{6}$/i.test(fallbackHex)) {
    return fallbackHex.toUpperCase();
  }
  const parsed = Number.parseFloat(srmVal);
  if (parsed === 0) return 'WATER';
  const normalized = Number.isFinite(parsed) ? parsed : 3;
  const srm = Math.max(0, Math.min(50, Math.round(normalized)));
  
  if (SRM_COLORS[srm]) return SRM_COLORS[srm];

  // Nearest SRM key interpolation for any unmapped integer between 1 and 50
  const keys = Object.keys(SRM_COLORS).map(Number).filter(k => k > 0).sort((a, b) => a - b);
  let closest = keys[0];
  for (const k of keys) {
    if (Math.abs(k - srm) < Math.abs(closest - srm)) {
      closest = k;
    }
  }
  return SRM_COLORS[closest] || "#200100";
}

let generatedGraphicId = 0;

/**
 * Generate randomized SVG animated carbonation bubbles (Standard half-speed, ~6 bubbles)
 */
function renderCarbonationBubbles(leftX, rightX, bottomY, topY, count = 6) {
  let bubblesSvg = '';
  const width = rightX - leftX;

  for (let i = 0; i < count; i++) {
    const cx = (leftX + 5 + Math.random() * (width - 10)).toFixed(1);
    const startY = (bottomY - Math.random() * 30).toFixed(1);
    const r = (1.0 + Math.random() * 1.5).toFixed(1);
    const duration = (4.0 + Math.random() * 4.5).toFixed(2);
    const delay = (Math.random() * 4.0).toFixed(2);
    const opacity = (0.35 + Math.random() * 0.45).toFixed(2);
    const riseDist = (startY - topY + 5).toFixed(1);

    bubblesSvg += `
      <circle cx="${cx}" cy="${startY}" r="${r}" fill="#FFFFFF" opacity="${opacity}" 
              style="--rise-dist: -${riseDist}px; animation: riseBubble ${duration}s infinite linear ${delay}s; transform-box: fill-box; transform-origin: center;" />
    `;
  }
  return bubblesSvg;
}

export function renderTapGraphic(
  style = 'corny_keg',
  percent = 100,
  colorHex = '#E8A317',
  isPouring = false,
  instanceId = `graphic_${generatedGraphicId++}`
) {
  const fillPct = Math.max(0, Math.min(100, parseFloat(percent) || 0));
  const isWater = colorHex === 'WATER' || colorHex === '#E0F7FA' || colorHex === '0';
  const beerColor = isWater ? 'WATER' : (typeof colorHex === 'string' && /^#[0-9a-f]{6}$/i.test(colorHex) ? colorHex.toUpperCase() : '#E8A317');
  const id = String(instanceId).replace(/[^a-zA-Z0-9_-]/g, '_');

  switch (style) {
    case 'wheat_glass':
      return renderWheatGlass(fillPct, beerColor, isPouring, id);
    case 'tulip_glass':
      return renderTulipGlass(fillPct, beerColor, isPouring, id);
    case 'mug':
      return renderMug(fillPct, beerColor, isPouring, id);
    case 'pint_glass':
      return renderPintGlass(fillPct, beerColor, isPouring, id);
    case 'stout_glass':
      return renderStoutGlass(fillPct, beerColor, isPouring, id);
    case 'snifter':
      return renderSnifter(fillPct, beerColor, isPouring, id);
    case 'corny_keg':
    default:
      return renderCornyKeg(fillPct, beerColor, isPouring, id);
  }
}

/**
 * CORNY KEG SVG RENDERER
 */
function renderCornyKeg(pct, color, isPouring, id) {
  const liquidY = 220 - (pct / 100) * 150;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';

  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.22)"`
    : `fill="url(#liquidGrad_${id})"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="kegBodyGrad_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#4A5568" />
          <stop offset="25%" stop-color="#A0AEC0" />
          <stop offset="50%" stop-color="#E2E8F0" />
          <stop offset="80%" stop-color="#A0AEC0" />
          <stop offset="100%" stop-color="#2D3748" />
        </linearGradient>
        ${!isWater ? `
          <linearGradient id="liquidGrad_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.85" />
            <stop offset="50%" stop-color="${color}" stop-opacity="1" />
            <stop offset="100%" stop-color="${color}" stop-opacity="0.9" />
          </linearGradient>
        ` : ''}
        <clipPath id="kegLiquidClip_${id}">
          <rect x="35" y="${liquidY}" width="90" height="${220 - liquidY}" rx="4" class="beer-liquid-clip" />
        </clipPath>
      </defs>

      <!-- Keg Handle & Top Body -->
      <path d="M 38 20 C 38 12, 122 12, 122 20 L 125 50 C 125 55, 35 55, 35 50 Z" fill="#1A202C" />
      <rect x="52" y="24" width="22" height="14" rx="4" fill="#000000" opacity="0.6" />
      <rect x="86" y="24" width="22" height="14" rx="4" fill="#000000" opacity="0.6" />
      <circle cx="80" cy="38" r="4" fill="#A0AEC0" />

      <!-- Keg Main Stainless Steel Body -->
      <rect x="32" y="52" width="96" height="175" rx="14" fill="url(#kegBodyGrad_${id})" stroke="#2D3748" stroke-width="2" />
      
      <!-- Transparent Window for Liquid Level -->
      <rect x="35" y="65" width="90" height="155" rx="6" fill="#1A202C" opacity="0.75" />

      <!-- Liquid Fill with Two-Tone SRM Split & Clipped Foam Head -->
      ${pct > 0 ? `
        <g clip-path="url(#kegLiquidClip_${id})">
          <rect x="30" y="${liquidY}" width="100" height="${220 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <!-- Two-Tone Darker SRM Right-Half Overlay -->
          <rect x="80" y="${liquidY}" width="50" height="${220 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(38, 122, 218, liquidY, 6)}
          ${!isWater ? `
            <!-- Puffy Cloud Foam Head (Clipped to Keg Walls) -->
            <g class="beer-cloud-foam">
              <rect x="30" y="${liquidY - 8}" width="100" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="48" cy="${liquidY - 5}" r="12" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="15" fill="${foamColor}" />
              <circle cx="88" cy="${liquidY - 7}" r="14" fill="${foamColor}" />
              <circle cx="108" cy="${liquidY - 5}" r="11" fill="${foamColor}" />
              <circle cx="74" cy="${liquidY - 9}" r="10" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <!-- Pour Stream Group -->
      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <!-- Glass Highlight -->
      <path d="M 40 68 L 46 68 L 46 215 L 40 215 Z" fill="#FFFFFF" opacity="0.15" />
      <path d="M 32 220 L 128 220 L 125 245 C 125 250, 35 250, 35 245 Z" fill="#1A202C" />
    </svg>
  `;
}

/**
 * PINT GLASS SVG RENDERER
 */
function renderPintGlass(pct, color, isPouring, id) {
  const liquidY = 220 - (pct / 100) * 165;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.25)"`
    : `fill="${color}" opacity="0.9"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="pintGlassClip_${id}">
          <polygon points="46,45 114,45 104,225 56,225" />
        </clipPath>
      </defs>

      <ellipse cx="80" cy="228" rx="25" ry="6" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <polygon points="45,40 115,40 105,225 55,225" 
               fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      ${pct > 0 ? `
        <g clip-path="url(#pintGlassClip_${id})">
          <rect x="30" y="${liquidY}" width="100" height="${230 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <!-- Two-Tone Darker SRM Right-Half Overlay -->
          <rect x="80" y="${liquidY}" width="50" height="${230 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(50, 110, 220, liquidY, 6)}
          ${!isWater ? `
            <!-- Puffy Cloud Foam Head (Clipped to Pint Glass Walls) -->
            <g class="beer-cloud-foam">
              <rect x="30" y="${liquidY - 8}" width="100" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="50" cy="${liquidY - 5}" r="11" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="14" fill="${foamColor}" />
              <circle cx="88" cy="${liquidY - 7}" r="13" fill="${foamColor}" />
              <circle cx="106" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="72" cy="${liquidY - 9}" r="9" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <!-- Pour Stream Group -->
      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <polygon points="48,45 54,45 59,220 54,220" fill="#FFFFFF" opacity="0.25" />
    </svg>
  `;
}

/**
 * WHEAT GLASS SVG RENDERER
 */
function renderWheatGlass(pct, color, isPouring, id) {
  const liquidY = 220 - (pct / 100) * 170;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.25)"`
    : `fill="url(#wheatLiquid_${id})"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${!isWater ? `
          <linearGradient id="wheatLiquid_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.8" />
            <stop offset="50%" stop-color="${color}" stop-opacity="1.0" />
            <stop offset="100%" stop-color="${color}" stop-opacity="0.85" />
          </linearGradient>
        ` : ''}
        <clipPath id="wheatGlassClip_${id}">
          <path d="M 50 30 Q 30 110, 62 170 L 60 220 Q 80 225, 100 220 L 98 170 Q 130 110, 110 30 Z" />
        </clipPath>
      </defs>

      <ellipse cx="80" cy="235" rx="35" ry="8" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <path d="M 50 30 Q 30 110, 62 170 L 60 220 Q 80 225, 100 220 L 98 170 Q 130 110, 110 30 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      ${pct > 0 ? `
        <g clip-path="url(#wheatGlassClip_${id})">
          <rect x="25" y="${liquidY}" width="110" height="${240 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <rect x="80" y="${liquidY}" width="55" height="${240 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(45, 115, 215, liquidY, 6)}
          ${!isWater ? `
            <g class="beer-cloud-foam">
              <rect x="25" y="${liquidY - 8}" width="110" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="48" cy="${liquidY - 5}" r="11" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="14" fill="${foamColor}" />
              <circle cx="88" cy="${liquidY - 7}" r="13" fill="${foamColor}" />
              <circle cx="106" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="72" cy="${liquidY - 9}" r="9" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <path d="M 55 35 Q 40 100, 64 165" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.4" stroke-linecap="round" />
    </svg>
  `;
}

/**
 * TULIP GLASS SVG RENDERER
 */
function renderTulipGlass(pct, color, isPouring, id) {
  const liquidY = 210 - (pct / 100) * 140;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.25)"`
    : `fill="${color}" opacity="0.9"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="tulipGlassClip_${id}">
          <path d="M 52 40 C 40 90, 30 150, 80 170 C 130 150, 120 90, 108 40 C 95 38, 65 38, 52 40 Z" />
        </clipPath>
      </defs>

      <ellipse cx="80" cy="235" rx="34" ry="7" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <rect x="76" y="170" width="8" height="65" fill="#E2E8F0" opacity="0.4" />

      <path d="M 52 40 C 40 90, 30 150, 80 170 C 130 150, 120 90, 108 40 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      ${pct > 0 ? `
        <g clip-path="url(#tulipGlassClip_${id})">
          <rect x="25" y="${liquidY}" width="110" height="${220 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <rect x="80" y="${liquidY}" width="55" height="${220 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(45, 115, 165, liquidY, 6)}
          ${!isWater ? `
            <g class="beer-cloud-foam">
              <rect x="25" y="${liquidY - 8}" width="110" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="48" cy="${liquidY - 5}" r="11" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="14" fill="${foamColor}" />
              <circle cx="88" cy="${liquidY - 7}" r="13" fill="${foamColor}" />
              <circle cx="106" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="72" cy="${liquidY - 9}" r="9" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <path d="M 56 45 C 46 90, 42 135, 75 162" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.4" />
    </svg>
  `;
}

/**
 * OKTOBERFEST MUG SVG RENDERER
 */
function renderMug(pct, color, isPouring, id) {
  const liquidY = 215 - (pct / 100) * 145;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.25)"`
    : `fill="${color}" opacity="0.9"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="mugGlassClip_${id}">
          <rect x="42" y="55" width="76" height="160" rx="6" />
        </clipPath>
      </defs>

      <path d="M 118 75 C 150 75, 150 185, 118 185 L 118 165 C 135 165, 135 95, 118 95 Z" 
            fill="#CBD5E0" opacity="0.4" stroke="#A0AEC0" stroke-width="1.5" />

      <rect x="40" y="50" width="80" height="170" rx="8" fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />
      <line x1="60" y1="50" x2="60" y2="220" stroke="#718096" stroke-width="1.5" opacity="0.4" />
      <line x1="80" y1="50" x2="80" y2="220" stroke="#718096" stroke-width="1.5" opacity="0.4" />
      <line x1="100" y1="50" x2="100" y2="220" stroke="#718096" stroke-width="1.5" opacity="0.4" />

      ${pct > 0 ? `
        <g clip-path="url(#mugGlassClip_${id})">
          <rect x="35" y="${liquidY}" width="90" height="${220 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <rect x="80" y="${liquidY}" width="45" height="${220 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(45, 115, 210, liquidY, 6)}
          ${!isWater ? `
            <g class="beer-cloud-foam">
              <rect x="40" y="${liquidY - 8}" width="80" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="52" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="13" fill="${foamColor}" />
              <circle cx="86" cy="${liquidY - 7}" r="13" fill="${foamColor}" />
              <circle cx="102" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="72" cy="${liquidY - 9}" r="8" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <rect x="44" y="55" width="6" height="160" rx="3" fill="#FFFFFF" opacity="0.2" />
    </svg>
  `;
}

/**
 * STOUT GLASS SVG RENDERER
 */
function renderStoutGlass(pct, color, isPouring, id) {
  const liquidY = 215 - (pct / 100) * 155;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.25)"`
    : `fill="${color}" opacity="0.9"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="stoutGlassClip_${id}">
          <path d="M 52 45 C 44 80, 40 120, 58 175 L 56 220 Q 80 225, 104 220 L 102 175 C 120 120, 116 80, 108 45 Z" />
        </clipPath>
      </defs>

      <ellipse cx="80" cy="235" rx="30" ry="7" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <path d="M 52 45 C 44 80, 40 120, 58 175 L 56 220 Q 80 225, 104 220 L 102 175 C 120 120, 116 80, 108 45 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      ${pct > 0 ? `
        <g clip-path="url(#stoutGlassClip_${id})">
          <rect x="25" y="${liquidY}" width="110" height="${230 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <rect x="80" y="${liquidY}" width="55" height="${230 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(48, 112, 215, liquidY, 6)}
          ${!isWater ? `
            <g class="beer-cloud-foam">
              <rect x="25" y="${liquidY - 8}" width="110" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="48" cy="${liquidY - 5}" r="11" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="14" fill="${foamColor}" />
              <circle cx="88" cy="${liquidY - 7}" r="13" fill="${foamColor}" />
              <circle cx="106" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="72" cy="${liquidY - 9}" r="9" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <path d="M 55 50 C 48 85, 46 120, 60 170" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.35" />
    </svg>
  `;
}

/**
 * SNIFTER GLASS SVG RENDERER
 */
function renderSnifter(pct, color, isPouring, id) {
  const liquidY = 205 - (pct / 100) * 125;
  const isWater = color === 'WATER';
  const isDark = color === '#080100' || color === '#130100' || color === '#200100' || color === '#280200' || color === '#000000';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const fillStyle = isWater
    ? `fill="rgba(224, 247, 250, 0.25)"`
    : `fill="${color}" opacity="0.9"`;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="snifterGlassClip_${id}">
          <path d="M 58 55 C 32 105, 32 155, 80 175 C 128 155, 128 105, 102 55 Z" />
        </clipPath>
      </defs>

      <ellipse cx="80" cy="235" rx="35" ry="7" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <rect x="76" y="175" width="8" height="60" fill="#E2E8F0" opacity="0.4" />

      <path d="M 58 55 C 32 105, 32 155, 80 175 C 128 155, 128 105, 102 55 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      ${pct > 0 ? `
        <g clip-path="url(#snifterGlassClip_${id})">
          <rect x="20" y="${liquidY}" width="120" height="${210 - liquidY}" ${fillStyle} class="beer-liquid-rect" />
          <rect x="80" y="${liquidY}" width="60" height="${210 - liquidY}" fill="rgba(0, 0, 0, 0.22)" class="beer-liquid-shadow" />
          ${renderCarbonationBubbles(42, 118, 170, liquidY, 6)}
          ${!isWater ? `
            <g class="beer-cloud-foam">
              <rect x="20" y="${liquidY - 8}" width="120" height="16" fill="${foamColor}" opacity="0.9" />
              <circle cx="48" cy="${liquidY - 5}" r="11" fill="${foamColor}" />
              <circle cx="68" cy="${liquidY - 8}" r="14" fill="${foamColor}" />
              <circle cx="88" cy="${liquidY - 7}" r="13" fill="${foamColor}" />
              <circle cx="106" cy="${liquidY - 5}" r="10" fill="${foamColor}" />
              <circle cx="72" cy="${liquidY - 9}" r="9" fill="#FFFFFF" opacity="0.5" />
            </g>
          ` : ''}
        </g>
      ` : ''}

      <g class="pour-stream-group ${isPouring ? 'is-active' : ''}">
        <rect x="76" y="0" width="8" height="${liquidY + 10}" fill="${isWater ? 'rgba(224, 247, 250, 0.85)' : color}" rx="4" class="liquid-pour-stream-bar" />
        <rect x="80" y="0" width="4" height="${liquidY + 10}" fill="rgba(0,0,0,0.22)" rx="2" />
      </g>

      <path d="M 60 60 C 40 105, 42 150, 72 168" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.4" />
    </svg>
  `;
}
