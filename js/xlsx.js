/* Writes an .xlsx file: a zip of a few XML parts, stored uncompressed.
 * Strings stay text, so barcodes keep their leading zeros in Excel. */
(function (root) {
  'use strict';

  var STYLE_HEADER = 1, STYLE_MONEY = 2;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colName(i) {
    var s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
  }

  // sheet: { name, columns: [{ title, width, money }], rows: [[cell, ...], ...] }
  function sheetXml(sheet) {
    var cols = sheet.columns.map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.width + '" customWidth="1"/>';
    }).join('');
    var head = sheet.columns.map(function (c, i) {
      return '<c r="' + colName(i) + '1" s="' + STYLE_HEADER + '" t="inlineStr"><is><t>' + esc(c.title) + '</t></is></c>';
    }).join('');
    var rows = sheet.rows.map(function (row, r) {
      var cells = row.map(function (v, i) {
        var ref = colName(i) + (r + 2);
        if (v == null || v === '') return '';
        if (typeof v === 'number') {
          return '<c r="' + ref + '"' + (sheet.columns[i].money ? ' s="' + STYLE_MONEY + '"' : '') + '><v>' + v + '</v></c>';
        }
        return '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 2) + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<cols>' + cols + '</cols><sheetData><row r="1">' + head + '</row>' + rows + '</sheetData></worksheet>';
  }

  function parts(sheets) {
    var main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    var rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return [
      ['[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>'],
      ['_rels/.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', head + '<workbook xmlns="' + main + '" xmlns:r="' + rel + '"><sheets>' +
        sheets.map(function (s, i) {
          return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('') + '</sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) {
          return '<Relationship Id="rId' + (i + 1) + '" Type="' + rel + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + rel + '/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', head + '<styleSheet xmlns="' + main + '">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '</styleSheet>']
    ].concat(sheets.map(function (s, i) {
      return ['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)];
    }));
  }

  /* ---------- zip (stored, no compression) ---------- */

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files, when) {
    var enc = new TextEncoder();
    var time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    var date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    var entries = files.map(function (f) {
      var name = enc.encode(f[0]), data = enc.encode(f[1]);
      return { name: name, data: data, crc: crc32(data) };
    });
    var size = 22;
    entries.forEach(function (e) { size += 30 + 46 + 2 * e.name.length + e.data.length; });
    var out = new Uint8Array(size), v = new DataView(out.buffer), p = 0;
    function u16(x) { v.setUint16(p, x, true); p += 2; }
    function u32(x) { v.setUint32(p, x, true); p += 4; }
    function common(e) {           // version needed … name length, shared by both headers
      u16(20); u16(0x0800); u16(0); u16(time); u16(date);
      u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    }
    entries.forEach(function (e) {
      e.offset = p;
      u32(0x04034b50);
      common(e);
      out.set(e.name, p); p += e.name.length;
      out.set(e.data, p); p += e.data.length;
    });
    var dir = p;
    entries.forEach(function (e) {
      u32(0x02014b50);
      u16(20);
      common(e);
      u16(0); u16(0); u16(0); u32(0);
      u32(e.offset);
      out.set(e.name, p); p += e.name.length;
    });
    var dirSize = p - dir;
    u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
    u32(dirSize); u32(dir); u16(0);
    return out;
  }

  function build(sheets, when) { return zip(parts(sheets), when || new Date()); }

  var api = { build: build, MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Xlsx = api;
})(typeof self !== 'undefined' ? self : this);
