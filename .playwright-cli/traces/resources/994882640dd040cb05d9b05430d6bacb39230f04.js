/*
 * セレクトボックス操作のイベント制御
 */
function grpidClick() {
  $('.grpselect').change(function () {
    localStorage.setItem('groupid', $(this).val());
    // Init Parameter
    localStorage.setItem('page', 1);
    const text = document.getElementById('textbox');
    text.textContent = 1;
    // Change the number of pages
    const pgvalue = localStorage.getItem('grpidvalueorg');
    const pgvalues = pgvalue.split(',');
    document.getElementById('pagemax').textContent = pgvalues[$(this).prop('selectedIndex')];
    // iframe Update
    iframeUpdate();
  });
}

/*
 * ページ切替操作のイベント制御
 */
$(() => {
  const downbutton = document.getElementById('down');
  const upbutton = document.getElementById('up');
  const text = document.getElementById('textbox');
  const pagemax = document.getElementById('pagemax');

  //ページダウン要求
  downbutton.addEventListener('click', (event) => {
    if (text.textContent > 1) {
      text.textContent--;
      localStorage.setItem('page', text.textContent);
      iframeUpdate(); // iframe Update
    }
  });
  //ページアップ要求
  upbutton.addEventListener('click', (event) => {
    if (text.textContent < pagemax.textContent) {
      text.textContent++;
      localStorage.setItem('page', text.textContent);
      iframeUpdate(); // iframe Update
    }
  });
});

/*
 * チェックボックス操作のイベント制御（時間／10分）
 */
function ktmClick() {
  $('input[name="ktm"]').change(function () {
    localStorage.setItem('ktm', $(this).val());
    iframeUpdate(); // iframe Update
    //console.log("menuparam ktmClick["+$(this).val()+"]");
  });
}

/*
 * チェックボックス操作のイベント制御（60分間雨量_警戒値／累加雨量_警戒値）
 */
function kraClick() {
  $('input[name="kra"]').change(function () {
    localStorage.setItem('kra', $(this).val());
    iframeUpdate(); // iframe Update
    //console.log("menuparam kraClick["+$(this).val()+"]");
  });
}

/*
 * iframeに表示する画面用パラメータセット
 */
function iframeUpdate() {
  // URL Pass Get
  let dispurl = document.getElementById(suburlget()).href;

  // "groupID" setup process
  const grpidsts = localStorage.getItem('grpid_' + suburlget());
  if (localStorage.getItem('grpid_' + suburlget()) == 'true') {
    let selectgrp = localStorage.getItem('groupid');
    if (localStorage.getItem('groupid') == null) {
      const slt = document.getElementsByName('grpid');
      const idx = slt[0].selectedIndex;
      selectgrp = slt[0][idx].value;
    }
    // grpId or myMenuId ?
    if (localStorage.getItem('urlid') != g_url_05_00) dispurl = dispurl + '&grpId=' + selectgrp;
    else dispurl = dispurl + '&myMenuId=' + selectgrp;
  }
  // "PG" setup process
  if (localStorage.getItem('pg_' + suburlget()) == 'true') {
    let pagenum = 1;
    if (localStorage.getItem('page') != null) {
      pagenum = localStorage.getItem('page');
    }
    dispurl = dispurl + '&PG=' + pagenum;
  }
  // "KTM" setup process
  if (localStorage.getItem('ktm_' + suburlget()) == 'true') {
    let ktmnum = 1; // 1:hour 3:10m
    if (localStorage.getItem('ktm') != null) {
      ktmnum = localStorage.getItem('ktm');
    }
    dispurl = dispurl + '&KTM=' + ktmnum;
  }
  // "KRA" setup process
  if (localStorage.getItem('kra_' + suburlget()) == 'true') {
    let kranum = 3; // 3:60m 13:ruika
    if (localStorage.getItem('kra') != null) {
      kranum = localStorage.getItem('kra');
    }
    dispurl = dispurl + '&KRA=' + kranum;
  }

  // 画面切り替え要求
  ifr.location = dispurl;
  console.log('menuparam dispurl[' + dispurl + ']');
}
