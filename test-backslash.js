// Test backslash handling
const a = 'hello\\nworld';  // should have \n as literal
const b = /\\`/g;           // regex matching \`
const c = /\\\\u/g;         // regex matching \\u
console.log(a, b, c);
