// fix-escapes.js - Runtime fix for MCP double-escaping in dashboardRoutes.js
// Uses String.fromCharCode to avoid ANY backslash in source (MCP doubles them)
var fs = require('fs');
var path = require('path');
var file = path.join(__dirname, 'src', 'routes', 'dashboardRoutes.js');

if (fs.existsSync(file)) {
  var content = fs.readFileSync(file, 'utf8');
  var before = content.length;
  var BS = String.fromCharCode(92);  // backslash
  var BT = String.fromCharCode(96);  // backtick
  var DL = String.fromCharCode(36);  // dollar sign

  // Fix escaped backticks: BS+BT -> BT
  content = content.split(BS + BT).join(BT);

  // Fix escaped dollar signs: BS+DL -> DL
  content = content.split(BS + DL).join(DL);

  // Fix double-escaped unicode: BS+BS+u -> BS+u (Node.js template literals handle the rest)
  content = content.split(BS + BS + 'u').join(BS + 'u');

  if (content.length !== before) {
    fs.writeFileSync(file, content, 'utf8');
    console.log('fix-escapes: Fixed dashboard (' + before + ' -> ' + content.length + ' bytes)');
  } else {
    console.log('fix-escapes: No issues found');
  }
} else {
  console.log('fix-escapes: Dashboard file not found, skipping');
}
