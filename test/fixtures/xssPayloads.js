export const storedXssPayloads = Object.freeze([
  '<img src=x onerror="globalThis.__xss = true">',
  '\"><img src=x onerror=globalThis.__xss=true>',
  '&lt;img src=x onerror=globalThis.__xss=true&gt;',
  '<svg><script>globalThis.__xss = true</script></svg>',
  'javascript:globalThis.__xss = true'
]);

export const xssPayloads = Object.freeze({
  text: storedXssPayloads[0],
  style: 'corny_keg\"><script>globalThis.__xss = true</script>',
  color: '" onload="globalThis.__xss = true',
  id: 'tap\"><script>globalThis.__xss = true</script>'
});
