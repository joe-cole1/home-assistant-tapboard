/**
 * TAP BOARD GRAPHICS ENGINE (graphics.js)
 * High-performance dynamic SVG vector renderer for Corny Kegs & 6 Beer Glassware styles.
 * Renders liquid level, exact SRM beer color hex, animated effervescent bubbles,
 * and a dynamic foam head cap at the top liquid level.
 */

// SRM to Hex Color conversion fallback table
const SRM_COLORS = {
  0: "#FFFFFF",
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
  25: "#380600",
  30: "#280200",
  35: "#1D0100",
  40: "#130100",
  50: "#080100"
};

/**
 * Helper to get Hex color from SRM number if hex string is not directly supplied
 */
export function srmToHex(srmVal, fallbackHex = null) {
  if (typeof fallbackHex === 'string' && /^#[0-9a-f]{6}$/i.test(fallbackHex)) {
    return fallbackHex.toUpperCase();
  }
  const parsed = Number.parseFloat(srmVal);
  const normalized = Number.isFinite(parsed) ? parsed : 3;
  const srm = Math.max(0, Math.min(50, Math.round(normalized)));
  if (SRM_COLORS[srm]) return SRM_COLORS[srm];
  
  // Interpolate between closest keys
  const keys = Object.keys(SRM_COLORS).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < keys.length - 1; i++) {
    if (srm >= keys[i] && srm <= keys[i + 1]) {
      return SRM_COLORS[keys[i]];
    }
  }
  return "#E8A317"; // Gold default
}

let generatedGraphicId = 0;

/**
 * Primary Render Function for Tap Graphics
 * @param {string} style - 'corny_keg', 'wheat_glass', 'tulip_glass', 'mug', 'pint_glass', 'stout_glass', 'snifter'
 * @param {number} percent - 0 to 100
 * @param {string} colorHex - liquid color in hex format
 * @param {boolean} isPouring - true if currently pouring to animate liquid motion
 * @param {string} instanceId - unique ID to deconflict SVG gradients and clipPaths
 */
export function renderTapGraphic(
  style = 'corny_keg',
  percent = 100,
  colorHex = '#E8A317',
  isPouring = false,
  instanceId = `graphic_${generatedGraphicId++}`
) {
  const fillPct = Math.max(0, Math.min(100, parseFloat(percent) || 0));
  const beerColor = typeof colorHex === 'string' && /^#[0-9a-f]{6}$/i.test(colorHex)
    ? colorHex.toUpperCase()
    : '#E8A317';
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
  const liquidY = 220 - (pct / 100) * 150; // Y ranges from 220 (0%) to 70 (100%)
  const foamY = Math.max(68, liquidY - 12);
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';

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
        <linearGradient id="liquidGrad_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${color}" stop-opacity="${isClear ? 0.05 : 0.85}" />
          <stop offset="40%" stop-color="${color}" stop-opacity="${isClear ? 0.15 : 1}" />
          <stop offset="100%" stop-color="${color}" stop-opacity="${isClear ? 0.1 : 0.9}" />
        </linearGradient>
        <clipPath id="kegLiquidClip_${id}">
          <rect x="35" y="${liquidY}" width="90" height="${220 - liquidY}" rx="4" />
        </clipPath>
      </defs>

      <!-- Keg Rubber Top Handle -->
      <path d="M 38 20 C 38 12, 122 12, 122 20 L 125 50 C 125 55, 35 55, 35 50 Z" fill="#1A202C" />
      <rect x="52" y="24" width="22" height="14" rx="4" fill="#000000" opacity="0.6" />
      <rect x="86" y="24" width="22" height="14" rx="4" fill="#000000" opacity="0.6" />
      <circle cx="80" cy="38" r="4" fill="#A0AEC0" />

      <!-- Keg Main Stainless Steel Body -->
      <rect x="32" y="52" width="96" height="175" rx="14" fill="url(#kegBodyGrad_${id})" stroke="#2D3748" stroke-width="2" />
      
      <!-- Body Rings/Ribs -->
      <line x1="32" y1="95" x2="128" y2="95" stroke="#718096" stroke-width="1.5" opacity="0.6" />
      <line x1="32" y1="180" x2="128" y2="180" stroke="#718096" stroke-width="1.5" opacity="0.6" />

      <!-- Transparent Window for Liquid Level -->
      <rect x="35" y="65" width="90" height="155" rx="6" fill="#1A202C" opacity="0.75" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#kegLiquidClip_${id})">
          <rect x="30" y="60" width="100" height="165" fill="url(#liquidGrad_${id})" />
          <!-- Animated Effervescent Bubbles -->
          <circle cx="45" cy="${liquidY + 20}" r="1.5" fill="#FFFFFF" opacity="0.6" class="bubble-anim-1" />
          <circle cx="65" cy="${liquidY + 45}" r="2" fill="#FFFFFF" opacity="0.5" class="bubble-anim-2" />
          <circle cx="85" cy="${liquidY + 15}" r="1" fill="#FFFFFF" opacity="0.7" class="bubble-anim-3" />
          <circle cx="105" cy="${liquidY + 35}" r="2" fill="#FFFFFF" opacity="0.6" class="bubble-anim-1" />
        </g>
        <!-- Foam Head Cap at Liquid Top -->
        ${!isClear ? `
          <path d="M 35 ${liquidY} Q 50 ${liquidY - 4}, 80 ${liquidY} Q 110 ${liquidY + 4}, 125 ${liquidY} L 125 ${foamY} Q 95 ${foamY - 3}, 65 ${foamY + 2} Q 35 ${foamY}, 35 ${liquidY} Z" 
                fill="${foamColor}" opacity="0.95" />
        ` : ''}
      ` : ''}

      <!-- Glass Highlight/Shine -->
      <path d="M 40 68 L 46 68 L 46 215 L 40 215 Z" fill="#FFFFFF" opacity="0.15" />

      <!-- Bottom Rubber Base -->
      <path d="M 32 220 L 128 220 L 125 245 C 125 250, 35 250, 35 245 Z" fill="#1A202C" />
    </svg>
  `;
}

/**
 * WHEAT BEER GLASS SVG RENDERER (Tall & Curvaceous)
 */
function renderWheatGlass(pct, color, isPouring, id) {
  const liquidY = 220 - (pct / 100) * 170;
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';

  const startOpacity = isClear ? 0.05 : 0.8;
  const midOpacity = isClear ? 0.15 : 1.0;
  const endOpacity = isClear ? 0.1 : 0.85;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wheatLiquid_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${color}" stop-opacity="${startOpacity}" />
          <stop offset="50%" stop-color="${color}" stop-opacity="${midOpacity}" />
          <stop offset="100%" stop-color="${color}" stop-opacity="${endOpacity}" />
        </linearGradient>
        <clipPath id="wheatGlassClip_${id}">
          <path d="M 50 30 Q 30 110, 62 170 L 60 220 Q 80 225, 100 220 L 98 170 Q 130 110, 110 30 Z" />
        </clipPath>
      </defs>

      <!-- Base -->
      <ellipse cx="80" cy="235" rx="35" ry="8" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <path d="M 72 220 L 88 220 L 92 235 L 68 235 Z" fill="#E2E8F0" opacity="0.3" />

      <!-- Glass Outline Background -->
      <path d="M 50 30 Q 30 110, 62 170 L 60 220 Q 80 225, 100 220 L 98 170 Q 130 110, 110 30 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#wheatGlassClip_${id})">
          <rect x="25" y="${liquidY}" width="110" height="${240 - liquidY}" fill="url(#wheatLiquid_${id})" />
          <!-- Animated Bubbles -->
          <circle cx="70" cy="${liquidY + 30}" r="1.5" fill="#FFF" opacity="0.6" class="bubble-anim-1" />
          <circle cx="85" cy="${liquidY + 60}" r="2" fill="#FFF" opacity="0.5" class="bubble-anim-2" />
          <circle cx="95" cy="${liquidY + 20}" r="1" fill="#FFF" opacity="0.7" class="bubble-anim-3" />
          <!-- Foam Cap -->
          ${!isClear ? `
            <ellipse cx="80" cy="${liquidY}" rx="${28 + (pct/100)*12}" ry="8" fill="${foamColor}" opacity="0.95" />
          ` : ''}
        </g>
      ` : ''}

      <!-- Glass Highlight -->
      <path d="M 55 35 Q 40 100, 64 165" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.4" stroke-linecap="round" />
    </svg>
  `;
}

/**
 * TULIP GLASS SVG RENDERER
 */
function renderTulipGlass(pct, color, isPouring, id) {
  const liquidY = 210 - (pct / 100) * 140;
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const liquidOpacity = isClear ? 0.15 : 0.9;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="tulipGlassClip_${id}">
          <path d="M 52 40 C 40 90, 30 150, 80 170 C 130 150, 120 90, 108 40 C 95 38, 65 38, 52 40 Z" />
        </clipPath>
      </defs>

      <!-- Base & Stem -->
      <ellipse cx="80" cy="235" rx="34" ry="7" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <rect x="76" y="170" width="8" height="65" fill="#E2E8F0" opacity="0.4" />

      <!-- Glass Bowl -->
      <path d="M 52 40 C 40 90, 30 150, 80 170 C 130 150, 120 90, 108 40 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#tulipGlassClip_${id})">
          <rect x="25" y="${liquidY}" width="110" height="${220 - liquidY}" fill="${color}" opacity="${liquidOpacity}" />
          <circle cx="70" cy="${liquidY + 25}" r="1.5" fill="#FFF" opacity="0.6" class="bubble-anim-1" />
          <circle cx="90" cy="${liquidY + 45}" r="2" fill="#FFF" opacity="0.5" class="bubble-anim-2" />
          <!-- Foam Cap -->
          ${!isClear ? `
            <ellipse cx="80" cy="${liquidY}" rx="${25 + (pct/100)*15}" ry="7" fill="${foamColor}" opacity="0.95" />
          ` : ''}
        </g>
      ` : ''}

      <!-- Glass Highlight -->
      <path d="M 56 45 C 46 90, 42 135, 75 162" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.4" />
    </svg>
  `;
}

/**
 * OKTOBERFEST MUG SVG RENDERER
 */
function renderMug(pct, color, isPouring, id) {
  const liquidY = 215 - (pct / 100) * 145;
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const liquidOpacity = isClear ? 0.15 : 0.9;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="mugGlassClip_${id}">
          <rect x="42" y="55" width="76" height="160" rx="6" />
        </clipPath>
      </defs>

      <!-- Handle -->
      <path d="M 118 75 C 150 75, 150 185, 118 185 L 118 165 C 135 165, 135 95, 118 95 Z" 
            fill="#CBD5E0" opacity="0.4" stroke="#A0AEC0" stroke-width="1.5" />

      <!-- Mug Body -->
      <rect x="40" y="50" width="80" height="170" rx="8" fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />
      <!-- Dimple Panel Lines -->
      <line x1="60" y1="50" x2="60" y2="220" stroke="#718096" stroke-width="1.5" opacity="0.4" />
      <line x1="80" y1="50" x2="80" y2="220" stroke="#718096" stroke-width="1.5" opacity="0.4" />
      <line x1="100" y1="50" x2="100" y2="220" stroke="#718096" stroke-width="1.5" opacity="0.4" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#mugGlassClip_${id})">
          <rect x="35" y="${liquidY}" width="90" height="${220 - liquidY}" fill="${color}" opacity="${liquidOpacity}" />
          <circle cx="65" cy="${liquidY + 20}" r="1.5" fill="#FFF" opacity="0.6" class="bubble-anim-1" />
          <circle cx="95" cy="${liquidY + 40}" r="2" fill="#FFF" opacity="0.5" class="bubble-anim-2" />
          <!-- Foam Cap -->
          ${!isClear ? `
            <rect x="42" y="${Math.max(52, liquidY - 14)}" width="76" height="14" rx="4" fill="${foamColor}" opacity="0.95" />
          ` : ''}
        </g>
      ` : ''}

      <!-- Glass Highlight -->
      <rect x="45" y="55" width="6" height="155" rx="3" fill="#FFFFFF" opacity="0.3" />
    </svg>
  `;
}

/**
 * SHAKER PINT GLASS SVG RENDERER
 */
function renderPintGlass(pct, color, isPouring, id) {
  const liquidY = 220 - (pct / 100) * 160;
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const liquidOpacity = isClear ? 0.15 : 0.9;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="pintGlassClip_${id}">
          <polygon points="45,45 115,45 102,225 58,225" />
        </clipPath>
      </defs>

      <!-- Glass Body -->
      <polygon points="45,45 115,45 102,225 58,225" fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#pintGlassClip_${id})">
          <rect x="35" y="${liquidY}" width="90" height="${230 - liquidY}" fill="${color}" opacity="${liquidOpacity}" />
          <circle cx="70" cy="${liquidY + 25}" r="1.5" fill="#FFF" opacity="0.6" class="bubble-anim-1" />
          <circle cx="90" cy="${liquidY + 45}" r="2" fill="#FFF" opacity="0.5" class="bubble-anim-2" />
          <!-- Foam Cap -->
          ${!isClear ? `
            <ellipse cx="80" cy="${liquidY}" rx="${28 + (pct/100)*7}" ry="6" fill="${foamColor}" opacity="0.95" />
          ` : ''}
        </g>
      ` : ''}

      <!-- Glass Highlight -->
      <line x1="50" y1="50" x2="61" y2="220" stroke="#FFFFFF" stroke-width="2.5" opacity="0.35" stroke-linecap="round" />
    </svg>
  `;
}

/**
 * STOUT GLASS SVG RENDERER
 */
function renderStoutGlass(pct, color, isPouring, id) {
  const liquidY = 220 - (pct / 100) * 155;
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const liquidOpacity = isClear ? 0.15 : 0.9;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="stoutGlassClip_${id}">
          <path d="M 52 45 C 42 100, 35 150, 60 180 L 60 225 L 100 225 L 100 180 C 125 150, 118 100, 108 45 Z" />
        </clipPath>
      </defs>

      <!-- Glass Body -->
      <path d="M 52 45 C 42 100, 35 150, 60 180 L 60 225 L 100 225 L 100 180 C 125 150, 118 100, 108 45 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#stoutGlassClip_${id})">
          <rect x="30" y="${liquidY}" width="100" height="${230 - liquidY}" fill="${color}" opacity="${liquidOpacity}" />
          <circle cx="75" cy="${liquidY + 30}" r="1.5" fill="#FFF" opacity="0.6" class="bubble-anim-1" />
          <!-- Foam Cap -->
          ${!isClear ? `
            <ellipse cx="80" cy="${liquidY}" rx="${26 + (pct/100)*10}" ry="6" fill="${foamColor}" opacity="0.95" />
          ` : ''}
        </g>
      ` : ''}

      <!-- Glass Highlight -->
      <path d="M 55 50 C 47 100, 42 145, 62 175" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.35" />
    </svg>
  `;
}

/**
 * SNIFTER GLASS SVG RENDERER
 */
function renderSnifter(pct, color, isPouring, id) {
  const liquidY = 205 - (pct / 100) * 125;
  const isDark = color === '#080100' || color === '#130100' || color === '#000000';
  const isClear = color === '#FFFFFF';
  const foamColor = isDark ? '#F5EBE6' : '#FFFDF5';
  const liquidOpacity = isClear ? 0.15 : 0.9;

  return `
    <svg viewBox="0 0 160 260" class="tap-graphic-svg ${isPouring ? 'is-pouring' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="snifterGlassClip_${id}">
          <path d="M 58 60 C 35 110, 35 160, 80 175 C 125 160, 125 110, 102 60 Z" />
        </clipPath>
      </defs>

      <!-- Stem & Base -->
      <ellipse cx="80" cy="235" rx="36" ry="7" fill="#E2E8F0" opacity="0.4" stroke="#CBD5E0" stroke-width="1.5" />
      <rect x="76" y="175" width="8" height="60" fill="#E2E8F0" opacity="0.4" />

      <!-- Glass Bowl -->
      <path d="M 58 60 C 35 110, 35 160, 80 175 C 125 160, 125 110, 102 60 Z" 
            fill="#1A202C" opacity="0.6" stroke="#CBD5E0" stroke-width="2" />

      <!-- Liquid Fill -->
      ${pct > 0 ? `
        <g clip-path="url(#snifterGlassClip_${id})">
          <rect x="30" y="${liquidY}" width="100" height="${220 - liquidY}" fill="${color}" opacity="${liquidOpacity}" />
          <circle cx="75" cy="${liquidY + 20}" r="1.5" fill="#FFF" opacity="0.6" class="bubble-anim-1" />
          <!-- Foam Cap -->
          ${!isClear ? `
            <ellipse cx="80" cy="${liquidY}" rx="${24 + (pct/100)*18}" ry="6" fill="${foamColor}" opacity="0.95" />
          ` : ''}
        </g>
      ` : ''}

      <!-- Highlight -->
      <path d="M 60 65 C 42 110, 42 150, 75 168" stroke="#FFFFFF" stroke-width="2.5" fill="none" opacity="0.35" />
    </svg>
  `;
}
