// fix-escapes.js - Fix template literal escaping in dashboardRoutes.js
// This runs during build to correct escaped backticks, unicode, and dollar signs
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'src/routes/dashboardRoutes.js');
if (fs.existsSync(file)) {
  let content = fs.readFileSync(file, 'utf8');
  const before = content.length;
  
  // Fix escaped backticks: \` -> `
  content = content.replace(/\\`/g, '`');
  
  // Fix double-escaped unicode: \\u -> \u  
  content = content.replace(/\\\\u/g, '\\u');
  
  // Fix escaped dollar signs: \$ -> $
  content = content.replace(/\\\$/g, '$');
  
  if (content.length !== before) {
    fs.writeFileSync(file, content, 'utf8');
    console.log('fix-escapes: Fixed dashboard escaping (' + before + ' -> ' + content.length + ' bytes)');
  } else {
    console.log('fix-escapes: No escaping issues found');
  }
} else {
  console.log('fix-escapes: Dashboard file not found, skipping');
}
