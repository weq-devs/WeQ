'use strict';

const OFFSET_MD5_BUFFER       = 0xB84600;
const OFFSET_SUB_8776F8_FINAL = 0xB84610;

function readStdString(ptr) {
  if (ptr.isNull()) return "<null>";
  try {
    var flag = ptr.readU8();
    if (flag & 1) {
      return ptr.add(16).readPointer().readCString();
    } else {
      return ptr.add(1).readCString();
    }
  } catch (e) {
    return "<err>";
  }
}

function hookGpro(base) {

  Interceptor.attach(base.add(0xB84300), {
    onEnter: function (args) {
      var path = readStdString(args[1]);
      var account = args[2].toUInt32();
      console.log('\n=========================================');
      console.log('[1. Entry] 数据库路径 = ' + path);
      console.log('[1. Entry] 传入账号 = ' + account + ' (0x' + account.toString(16) + ')');
    }
  });

  Interceptor.attach(base.add(OFFSET_MD5_BUFFER), {
    onEnter: function (args) {

      var bufferPtr = this.context.x0;
      var len = this.context.x1.toInt32();
      // console.log('\n[2. DB Header]  ExtHeader 长度: ' + len);
      if (len > 0 && len <= 256) {
        console.log('[2. DB Header] Hexdump :');
        console.log(hexdump(bufferPtr, { offset: 0, length: len, header: true, ansi: true }));
      }
    }
  });

  Interceptor.attach(base.add(OFFSET_SUB_8776F8_FINAL), {
    onEnter: function (args) {
      // var s1 = readStdString(this.context.x0);
      // var s2 = readStdString(this.context.x1);
      //
      // console.log('   参数 1: ' + s1);
      // console.log('   参数 2: ' + s2);

      this.outPtr = this.context.x8;
    },
    onLeave: function (retval) {
      var mixedResult = readStdString(this.outPtr);
      console.log('\n[3. Key Mix] sub_8776F8 output:');
      console.log('   -> ' + mixedResult);
    }
  });

  // 4. 原始的 sqlite3_key hook，验证最终密钥
  Interceptor.attach(base.add(0xB84664), {
    onEnter: function (args) {
      var nKey = args[2].toInt32();
      var key = '';
      try {
        key = args[1].readCString(nKey);
      } catch (e) {
        key = '<err>';
      }
      console.log('\n[4. sqlite3_key] nt_sqlite_key: ' + key);
      console.log('=========================================\n');
    }
  });
}

if (Process.arch !== 'arm64') {
  console.log('[hook.js] not arm64, skip');
} else {
  var m = Process.findModuleByName('libgpro.so');
  if (m) {
    hookGpro(ptr(m.base));
  } else {
    var tid = setInterval(function () {
      var mm = Process.findModuleByName('libgpro.so');
      if (mm) { clearInterval(tid); hookGpro(ptr(mm.base)); }
    }, 200);
  }
}
