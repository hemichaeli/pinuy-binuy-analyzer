// start.js - Combined startup script
console.log('[START] Running fix-escapes...');

// Run fix-escapes inline
var fs = require('fs');
var path = require('path');
var file = path.join(__dirname, 'src', 'routes', 'dashboardRoutes.js');

if (fs.existsSync(file)) {
  var content = fs.readFileSync(file, 'utf8');
  var before = content.length;
  var BS = String.fromCharCode(92);
  var BT = String.fromCharCode(96);
  var DL = String.fromCharCode(36);
  content = content.split(BS + BT).join(BT);
  content = content.split(BS + DL).join(DL);
  content = content.split(BS + BS + 'u').join(BS + 'u');
  if (content.length !== before) {
    fs.writeFileSync(file, content, 'utf8');
    console.log('[START] fix-escapes: Fixed (' + before + ' -> ' + content.length + ' bytes)');
  } else {
    console.log('[START] fix-escapes: No issues found');
  }
} else {
  console.log('[START] fix-escapes: File not found, skipping');
}

console.log('[START] Starting server...');

// Now require the actual server
require('./src/index.js');
