// JavaScript Document
// google Analytics
var imgArr = [
  'publicmenu_top_off',
  'publicmenu_top_on',
  'publicmenu_ame_off',
  'publicmenu_ame_on',
  'publicmenu_kaseninfo_off',
  'publicmenu_kaseninfo_on',
  'publicmenu_dosya_off',
  'publicmenu_dosya_on',
  'publicmenu_damu_off',
  'publicmenu_damu_on',
  'publicmenu_excess_off',
  'publicmenu_excess_on',
  'publicmenu_mizu_off',
  'publicmenu_mizu_on',
  'publicmenu_kisyo_off',
  'publicmenu_kisyo_on',
  'publicmenu_radar_off',
  'publicmenu_radar_on',
  'publicmenu_etc_off',
  'publicmenu_etc_on',
];
var imgOArr = new Array(imgArr.length);

for (var i = 0; (e = imgArr[i]); i++) {
  imgOArr[i] = new Image();
  imgOArr[i].src = '../menu/' + e + '.gif';
}

var mainMenuBase =
  '<li class="top"><a></a></li><li class="kisyo"><a></a></li><li class="kaseninfo"><a></a></li><li class="dosya"><a></a></li><li class="mizu"><a></a></li><li class="damu"><a></a></li><li class="ame"><a></a></li><li class="radar"><a></a></li><li class="excess"><a></a></li><li class="etc"><a></a></li>';
var mainMenu =
  '<div id="dd00" class="doAct" style="margin-left:-241px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">TOP画面</span></span><ul><li class="ml5"><a id="url_00_00" target=""    href="#" onclick="ifreameurlchg2(g_url_00_00);return true">トップメニュー</a></li><li class="ml5"><a id="url_00_01" target="ifr" href="#" onclick="ifreameurlchg(g_url_00_01);return false">使用上の注意項目</a></li><li class="ml5"><a id="url_00_02" target="ifr" href="#" onclick="ifreameurlchg(g_url_00_02);return false">用語の説明</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd01" class="doAct" style="margin-left:-241px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">気象情報</span></span><ul><li class="ml5"><a id="url_01_00" target="_blank" href="#" onclick="ifreameurlchg2(g_url_01_00);return true">警報・注意報(気象庁)</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd02" class="doAct" style="margin-left:-120px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">河川警戒情報</span></span><ul><li class="ml5"><a id="url_02_00" target="ifr" href="#" onclick="ifreameurlchg(g_url_02_00);return false">洪水予報管内図</a></li><li class="ml5"><a id="url_02_01" target="ifr" href="#" onclick="ifreameurlchg(g_url_02_01);return false">洪水予報状況履歴表</a></li><li class="ml5"><a id="url_02_02" target="ifr" href="#" onclick="ifreameurlchg(g_url_02_02);return false">ダム放流通知履歴表</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd03" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">土砂災害警戒情報</span></span><ul><li class="ml5"><a id="url_03_00" target="_blank" href="#" onclick="ifreameurlchg2(g_url_03_00);return true">えひめ土砂災害危険度情報</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd04" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">河川水位</span></span><ul><li class="ml5"><a id="url_04_00" target="ifr" href="#" onclick="ifreameurlchg(g_url_04_00);return false">水位観測所概況図</a></li><li class="ml5"><a id="url_04_01" target="ifr" href="#" onclick="ifreameurlchg(g_url_04_01);return false">時刻水位経過表</a></li><li class="ml5"><a id="url_04_02" target="ifr" href="#" onclick="ifreameurlchg(g_url_04_02);return false">基準値超過雨量観測所一覧表</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd05" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">ダム諸量</span></span><ul><li class="ml5"><a id="url_05_00" target="ifr" href="#" onclick="ifreameurlchg(g_url_05_00);return false">時刻ダム諸量経過表</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd06" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">雨量</span></span><ul><li class="ml5"><a id="url_06_00" target="ifr" href="#" onclick="ifreameurlchg(g_url_06_00);return false">雨量観測所概況図</a></li><li class="ml5"><a id="url_06_01" target="ifr" href="#" onclick="ifreameurlchg(g_url_06_01);return false">時刻雨量経過表</a></li><li class="ml5"><a id="url_06_02" target="ifr" href="#" onclick="ifreameurlchg(g_url_06_02);return false">基準値超過雨量観測所一覧表</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd07" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">レーダ雨量</span></span><ul><li class="ml5"><a id="url_07_02" target="ifr" href="#" onclick="ifreameurlchg(g_url_07_02);return false">現況レーダ雨量(広域)</a></li><li class="ml5"><a id="url_07_03" target="ifr" href="#" onclick="ifreameurlchg(g_url_07_03);return false">雨量レーダ履歴４分割(気象庁)</a></li><li class="ml5"><a id="url_07_04" target="_blank" href="#" onclick="ifreameurlchg2(g_url_07_04);return true">降水短時間予報(広域)(気象庁)</a></li><li class="ml5"><a id="url_07_05" target="_blank" href="#" onclick="ifreameurlchg2(g_url_07_05);return true">降水ナウキャスト(広域)(気象庁)</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd08" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">超過一覧</span></span><ul><li class="ml5"><a id="url_08_00" target="ifr" href="#" onclick="ifreameurlchg(g_url_08_00);return false">基準値超過雨量観測所一覧表</a></li><li class="ml5"><a id="url_08_01" target="ifr" href="#" onclick="ifreameurlchg(g_url_08_01);return false">基準値超過水位観測所一覧表</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div id="dd09" class="doAct" style="margin-left:0px;background-color:#fff;"><div class="ddInner"><ul class="text11 mr5 ml5"><li><span class="undefined act"><span class="futo">その他情報</span></span><ul><li class="ml5"><a id="url_09_00" target="ifr" href="#" onclick="ifreameurlchg(g_url_09_00);return false">水質観測所概況図</a></li><li class="ml5"><a id="url_09_01" target="ifr" href="#" onclick="ifreameurlchg(g_url_09_01);return false">時刻水質概況図</a></li></ul></li></ul></div><div class="clear pt3 tc ddClose"><img src="../menu/btn_close.gif" alt="閉じる" width="52" height="13" /></div></div><div class="contsHidCover" style="height: 850px; display: none;"></div>';

$(() => {
  $('#gMenu .mainMenu').html(mainMenuBase);

  $('#gMenu').append(mainMenu);

  $('.cLink a').css({ textDecoration: 'none', color: '#333' });
  $('.cLink a').hover(
    function () {
      $(this).css({ textDecoration: 'underline', color: '#03C' });
    },
    function () {
      $(this).css('color', '#333');
    },
  );
  $('.cLink').css({ lineHeight: '0', padding: '10px' });

  var userAgent = window.navigator.userAgent.toLowerCase();
  var appVersion = window.navigator.appVersion.toLowerCase();
  var browser;
  if (userAgent.indexOf('opera') != -1) {
    browser = 'opera';
  } else if (userAgent.indexOf('msie') != -1) {
    if (appVersion.indexOf('msie 6.') != -1) {
      browser = 'ie6';
    } else if (appVersion.indexOf('msie 7.') != -1) {
      browser = 'ie7';
    } else if (appVersion.indexOf('msie 8.') != -1) {
      browser = 'ie8';
    } else if (appVersion.indexOf('msie 9.') != -1) {
      browser = 'ie9';
    } else {
      browser = 'ie';
    }
  }

  $('.contsHidCover').height($('#mainContents').height() + 42);

  $('body').click(() => {
    if ($('.contsHidCover').is(':visible')) {
      ddClose('btn');
    }
  });

  let ifreamelocation = suburlget();

  /* Button buttons change the appropriate page */
  if (
    ifreamelocation.indexOf('url_00_00') != -1 ||
    ifreamelocation.indexOf('url_00_01') != -1 ||
    ifreamelocation.indexOf('url_00_02') != -1
  ) {
    $('#gMenu li.top a').css('background', 'url(../menu/publicmenu_top_on.gif)');
  } else if (ifreamelocation.indexOf('url_01_00') != -1) {
    $('#gMenu li.kisyo a').css('background', 'url(../menu/publicmenu_kisyo_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_02_00') != -1 ||
    ifreamelocation.indexOf('url_02_01') != -1 ||
    ifreamelocation.indexOf('url_02_02') != -1
  ) {
    $('#gMenu li.kaseninfo a').css('background', 'url(../menu/publicmenu_kaseninfo_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_03_00') != -1 ||
    ifreamelocation.indexOf('url_03_01') != -1 ||
    ifreamelocation.indexOf('url_03_02') != -1 ||
    ifreamelocation.indexOf('url_03_03') != -1 ||
    ifreamelocation.indexOf('url_03_04') != -1
  ) {
    $('#gMenu li.dosya a').css('background', 'url(../menu/publicmenu_dosya_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_04_00') != -1 ||
    ifreamelocation.indexOf('url_04_01') != -1 ||
    ifreamelocation.indexOf('url_04_02') != -1
  ) {
    $('#gMenu li.mizu a').css('background', 'url(../menu/publicmenu_mizu_on.gif)');
  } else if (ifreamelocation.indexOf('url_05_00') != -1) {
    $('#gMenu li.damu a').css('background', 'url(../menu/publicmenu_damu_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_06_00') != -1 ||
    ifreamelocation.indexOf('url_06_01') != -1 ||
    ifreamelocation.indexOf('url_06_02') != -1
  ) {
    $('#gMenu li.ame a').css('background', 'url(../menu/publicmenu_ame_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_07_00') != -1 ||
    ifreamelocation.indexOf('url_07_01') != -1 ||
    ifreamelocation.indexOf('url_07_02') != -1 ||
    ifreamelocation.indexOf('url_07_03') != -1 ||
    ifreamelocation.indexOf('url_07_04') != -1
  ) {
    $('#gMenu li.radar a').css('background', 'url(../menu/publicmenu_radar_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_08_00') != -1 ||
    ifreamelocation.indexOf('url_08_01') != -1
  ) {
    $('#gMenu li.excess a').css('background', 'url(../menu/publicmenu_excess_on.gif)');
  } else if (
    ifreamelocation.indexOf('url_09_00') != -1 ||
    ifreamelocation.indexOf('url_09_01') != -1
  ) {
    $('#gMenu li.etc a').css('background', 'url(../menu/publicmenu_etc_on.gif)');
  }

  $('#gMenu li.top a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd00').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_top_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_top_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_00_00') != -1 ||
            ifreamelocation.indexOf('url_00_01') != -1 ||
            ifreamelocation.indexOf('url_00_02') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_top_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_top_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.kisyo a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd01').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_kisyo_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_kisyo_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (ifreamelocation.indexOf('url_01_00') != -1) {
            $(this).css('background', 'url(../menu/publicmenu_kisyo_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_kisyo_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.kaseninfo a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd02').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_kaseninfo_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_kaseninfo_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_02_00') != -1 ||
            ifreamelocation.indexOf('url_02_01') != -1 ||
            ifreamelocation.indexOf('url_02_02') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_kaseninfo_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_kaseninfo_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.dosya a')
    .click(function (e) {
      // 未選択状態から押されたとき
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd03').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_dosya_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        // すでに選択された状態で押されたとき
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_dosya_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_03_00') != -1 ||
            ifreamelocation.indexOf('url_03_01') != -1 ||
            ifreamelocation.indexOf('url_03_02') != -1 ||
            ifreamelocation.indexOf('url_03_03') != -1 ||
            ifreamelocation.indexOf('url_03_04') != -1
          ) {
            // ボタンの上にマウスが置かれたとき（いずれかの画面が選択されているとき）
            $(this).css('background', 'url(../menu/publicmenu_dosya_on.gif)');
          } else {
            // ボタンの上にマウスが置かれたとき
            $(this).css('background', 'url(../menu/publicmenu_dosya_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.mizu a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd04').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_mizu_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_mizu_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_04_00') != -1 ||
            ifreamelocation.indexOf('url_04_01') != -1 ||
            ifreamelocation.indexOf('url_04_02') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_mizu_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_mizu_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.damu a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd05').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_damu_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_damu_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (ifreamelocation.indexOf('url_05_00') != -1) {
            $(this).css('background', 'url(../menu/publicmenu_damu_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_damu_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.ame a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 480;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd06').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_ame_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_ame_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_06_00') != -1 ||
            ifreamelocation.indexOf('url_06_01') != -1 ||
            ifreamelocation.indexOf('url_06_02') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_ame_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_ame_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.radar a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd07').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_radar_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_radar_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_07_00') != -1 ||
            ifreamelocation.indexOf('url_07_01') != -1 ||
            ifreamelocation.indexOf('url_07_02') != -1 ||
            ifreamelocation.indexOf('url_07_03') != -1 ||
            ifreamelocation.indexOf('url_07_04') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_radar_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_radar_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.excess a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 500;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd08').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_excess_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_excess_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_08_00') != -1 ||
            ifreamelocation.indexOf('url_08_01') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_excess_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_excess_off.gif)');
          }
        }
      },
    );

  $('#gMenu li.etc a')
    .click(function (e) {
      var ml = $(this).offset().left - $('.mainMenu').offset().left - 542;
      // url Switch
      ddClose();
      if (!$(this).hasClass('act')) {
        $('#dd09').css('margin-left', ml).slideDown(100);
        $(this).css('background', 'url(../menu/publicmenu_etc_on.gif)');
        $('#gMenu li a').removeClass('act');
        $(this).addClass('act');
        if (browser == 'ie6') {
          $('select').hide();
        }
        $('.contsHidCover')
          .height($('#mainContents').height() + 1100)
          .show();
      } else {
        $('#gMenu li a').removeClass('act');
      }
      return false;
    })
    .hover(
      function () {
        if (!$(this).hasClass('act')) {
          $(this).css('background', 'url(../menu/publicmenu_etc_on.gif)');
        }
      },
      function () {
        if (!$(this).hasClass('act')) {
          ifreamelocation = suburlget();
          if (
            ifreamelocation.indexOf('url_09_00') != -1 ||
            ifreamelocation.indexOf('url_09_01') != -1
          ) {
            $(this).css('background', 'url(../menu/publicmenu_etc_on.gif)');
          } else {
            $(this).css('background', 'url(../menu/publicmenu_etc_off.gif)');
          }
        }
      },
    );

  $('.ddClose')
    .click(() => {
      ddClose('btn');
    })
    .hover(
      function () {
        $(this).css('cursor', 'pointer');
      },
      function () {
        $(this).css('cursor', 'default');
      },
    );
});

function ddClose(_a) {
  $('#dd00').slideUp(100);
  $('#dd01').slideUp(100);
  $('#dd02').slideUp(100);
  $('#dd03').slideUp(100);
  $('#dd04').slideUp(100);
  $('#dd05').slideUp(100);
  $('#dd06').slideUp(100);
  $('#dd07').slideUp(100);
  $('#dd08').slideUp(100);
  $('#dd09').slideUp(100);

  $('#gMenu li.top a').css('background', 'url(../menu/publicmenu_top_off.gif)');
  $('#gMenu li.kisyo a').css('background', 'url(../menu/publicmenu_kisyo_off.gif)');
  $('#gMenu li.kaseninfo a').css('background', 'url(../menu/publicmenu_kaseninfo_off.gif)');
  $('#gMenu li.dosya a').css('background', 'url(../menu/publicmenu_dosya_off.gif)');
  $('#gMenu li.mizu a').css('background', 'url(../menu/publicmenu_mizu_off.gif)');
  $('#gMenu li.damu a').css('background', 'url(../menu/publicmenu_damu_off.gif)');
  $('#gMenu li.ame a').css('background', 'url(../menu/publicmenu_ame_off.gif)');
  $('#gMenu li.radar a').css('background', 'url(../menu/publicmenu_radar_off.gif)');
  $('#gMenu li.excess a').css('background', 'url(../menu/publicmenu_excess_off.gif)');
  $('#gMenu li.etc a').css('background', 'url(../menu/publicmenu_etc_off.gif)');

  // Menu Button status check
  const ifreamelocation = suburlget();

  if (
    ifreamelocation.indexOf('url_00_00') != -1 ||
    ifreamelocation.indexOf('url_00_01') != -1 ||
    ifreamelocation.indexOf('url_00_02') != -1
  ) {
    $('#gMenu li.top a').css('background', 'url(../menu/publicmenu_top_on.gif)');
  }
  if (ifreamelocation.indexOf('url_01_00') != -1) {
    $('#gMenu li.kisyo a').css('background', 'url(../menu/publicmenu_kisyo_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_02_00') != -1 ||
    ifreamelocation.indexOf('url_02_01') != -1 ||
    ifreamelocation.indexOf('url_02_02') != -1
  ) {
    $('#gMenu li.kaseninfo a').css('background', 'url(../menu/publicmenu_kaseninfo_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_03_00') != -1 ||
    ifreamelocation.indexOf('url_03_01') != -1 ||
    ifreamelocation.indexOf('url_03_02') != -1 ||
    ifreamelocation.indexOf('url_03_03') != -1 ||
    ifreamelocation.indexOf('url_03_04') != -1
  ) {
    $('#gMenu li.dosya a').css('background', 'url(../menu/publicmenu_dosya_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_04_00') != -1 ||
    ifreamelocation.indexOf('url_04_01') != -1 ||
    ifreamelocation.indexOf('url_04_02') != -1
  ) {
    $('#gMenu li.mizu a').css('background', 'url(../menu/publicmenu_mizu_on.gif)');
  }
  if (ifreamelocation.indexOf('url_05_00') != -1) {
    $('#gMenu li.damu a').css('background', 'url(../menu/publicmenu_damu_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_06_00') != -1 ||
    ifreamelocation.indexOf('url_06_01') != -1 ||
    ifreamelocation.indexOf('url_06_02') != -1
  ) {
    $('#gMenu li.ame a').css('background', 'url(../menu/publicmenu_ame_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_07_00') != -1 ||
    ifreamelocation.indexOf('url_07_01') != -1 ||
    ifreamelocation.indexOf('url_07_02') != -1 ||
    ifreamelocation.indexOf('url_07_03') != -1 ||
    ifreamelocation.indexOf('url_07_04') != -1
  ) {
    $('#gMenu li.radar a').css('background', 'url(../menu/publicmenu_radar_on.gif)');
  }
  if (ifreamelocation.indexOf('url_08_00') != -1 || ifreamelocation.indexOf('url_08_01') != -1) {
    $('#gMenu li.excess a').css('background', 'url(../menu/publicmenu_excess_on.gif)');
  }
  if (ifreamelocation.indexOf('url_09_00') != -1 || ifreamelocation.indexOf('url_09_01') != -1) {
    $('#gMenu li.etc a').css('background', 'url(../menu/publicmenu_etc_on.gif)');
  }

  $('.contsHidCover').hide();
  $('select').show();
  if (_a == 'btn') {
    $('#gMenu .mainMenu li a').removeClass('act');
  }
}

/* [http://xx/xx/xx?yyyyy?zzzz"] "yyyyy?zzzz" Get */
function suburlget() {
  const url_local = location.href.split('?');
  let suburl = '';
  for (let i = 1; i < url_local.length; i++) {
    if (i > 1) suburl += '?';
    suburl += url_local[i];
  }
  return suburl;
}

function ifreameurlchg(urlid) {
  // init
  localStorage.setItem('page', '1');
  //console.log("初期化 page["+localStorage.getItem('page')+"]");

  jsonDataGet();

  // Main URL Renewal
  var url_local = location.href.split('?');
  history.replaceState('', '', url_local[0] + '?' + document.getElementById(urlid).id);

  // Scene Title Renewal
  document.getElementById('gamenname').textContent = localStorage.getItem('title_' + urlid);

  // Menu Button status check
  const ifreamelocation = suburlget();

  if (
    ifreamelocation.indexOf('url_00_00') != -1 ||
    ifreamelocation.indexOf('url_00_01') != -1 ||
    ifreamelocation.indexOf('url_00_02') != -1
  ) {
    $('#gMenu li.top a').css('background', 'url(../menu/publicmenu_top_on.gif)');
  }
  if (ifreamelocation.indexOf('url_01_00') != -1) {
    $('#gMenu li.kisyo a').css('background', 'url(../menu/publicmenu_kisyo_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_02_00') != -1 ||
    ifreamelocation.indexOf('url_02_01') != -1 ||
    ifreamelocation.indexOf('url_02_02') != -1
  ) {
    $('#gMenu li.kaseninfo a').css('background', 'url(../menu/publicmenu_kaseninfo_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_03_00') != -1 ||
    ifreamelocation.indexOf('url_03_01') != -1 ||
    ifreamelocation.indexOf('url_03_02') != -1 ||
    ifreamelocation.indexOf('url_03_03') != -1 ||
    ifreamelocation.indexOf('url_03_04') != -1
  ) {
    $('#gMenu li.dosya a').css('background', 'url(../menu/publicmenu_dosya_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_04_00') != -1 ||
    ifreamelocation.indexOf('url_04_01') != -1 ||
    ifreamelocation.indexOf('url_04_02') != -1
  ) {
    $('#gMenu li.mizu a').css('background', 'url(../menu/publicmenu_mizu_on.gif)');
  }
  if (ifreamelocation.indexOf('url_05_00') != -1) {
    $('#gMenu li.damu a').css('background', 'url(../menu/publicmenu_damu_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_06_00') != -1 ||
    ifreamelocation.indexOf('url_06_01') != -1 ||
    ifreamelocation.indexOf('url_06_02') != -1
  ) {
    $('#gMenu li.ame a').css('background', 'url(../menu/publicmenu_ame_on.gif)');
  }
  if (
    ifreamelocation.indexOf('url_07_00') != -1 ||
    ifreamelocation.indexOf('url_07_01') != -1 ||
    ifreamelocation.indexOf('url_07_02') != -1 ||
    ifreamelocation.indexOf('url_07_03') != -1 ||
    ifreamelocation.indexOf('url_07_04') != -1
  ) {
    $('#gMenu li.radar a').css('background', 'url(../menu/publicmenu_radar_on.gif)');
  }
  if (ifreamelocation.indexOf('url_08_00') != -1 || ifreamelocation.indexOf('url_08_01') != -1) {
    $('#gMenu li.excess a').css('background', 'url(../menu/publicmenu_excess_on.gif)');
  }
  if (ifreamelocation.indexOf('url_09_00') != -1 || ifreamelocation.indexOf('url_09_01') != -1) {
    $('#gMenu li.etc a').css('background', 'url(../menu/publicmenu_etc_on.gif)');
  }

  operation(urlid);
}

function ifreameurlchg2(urlid) {
  //jsonDataGet();
}

/* パラメータ操作部の表示制御 */
function operation(urlid) {
  // Display group switching control
  let element = document.getElementById('grpid');
  if (localStorage.getItem('grpid_' + urlid) == 'true') element.classList.remove('grpidshow');
  else element.classList.add('grpidshow');

  // Page Button display control display switching
  element = document.getElementById('pg');
  if (localStorage.getItem('pg_' + urlid) == 'true') element.classList.remove('pgshow');
  else element.classList.add('pgshow');

  // Display interval switching control
  element = document.getElementById('ktm');
  if (localStorage.getItem('ktm_' + urlid) == 'true') element.classList.remove('ktmshow');
  else element.classList.add('ktmshow');

  // Warning price switching control
  element = document.getElementById('kra');
  if (localStorage.getItem('kra_' + urlid) == 'true') element.classList.remove('krashow');
  else element.classList.add('krashow');

  //console.log("operation end!!");
}
