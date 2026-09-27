'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSettings, appearanceFromSettings, readWindowsTerminalAppearance } = require('../core/windows-terminal-appearance');

test('JSONC comments and trailing commas never damage quoted values', () => {
  const source = '{/* comment */"url":"https://host/a,b}", "font":"A \\\"quoted\\\" font", // line\n "list":[1,2,],}';
  assert.deepEqual(parseSettings(source), {url:'https://host/a,b}',font:'A "quoted" font',list:[1,2]});
  assert.throws(() => parseSettings('{/* missing'), SyntaxError);
});

test('default profile overrides inherited settings with native point-to-pixel scale and palette', () => {
  const a = appearanceFromSettings({ defaultProfile:'chosen',
    profiles:{defaults:{font:{face:'MesloLGM Nerd Font',size:14},colorScheme:'Campbell'},
      list:[{guid:'chosen',font:{size:15},colorScheme:'Personal'}]},
    schemes:[{name:'Personal',background:'#123456',purple:'#112233',brightPurple:'#aabbcc',cursorColor:'#778899'}],
  });
  assert.match(a.fontFamily,/MesloLGM Nerd Font/);
  assert.equal(a.fontScale,1.25);
  assert.equal(a.theme.background,'#123456');
  assert.equal(a.theme.magenta,'#112233');
  assert.equal(a.theme.brightMagenta,'#aabbcc');
  assert.equal(a.theme.cursor,'#778899');
  assert.equal(a.warning,null);
});

test('unreadable settings are diagnosed while absent installations use standard terminal defaults', () => {
  const reports=[];
  const a=readWindowsTerminalAppearance({env:{LOCALAPPDATA:'C:/fixture'},readFile:()=>'{invalid',warn:s=>reports.push(s)});
  assert.equal(reports.length,3);
  assert.equal(a.theme.background,'#0c0c0c');
  const b=readWindowsTerminalAppearance({env:{},readFile:()=>{throw Error('must not read');}});
  assert.match(b.fontFamily,/Cascadia Mono/);
});
