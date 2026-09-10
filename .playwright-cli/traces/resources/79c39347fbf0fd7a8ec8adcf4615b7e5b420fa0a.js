// JavaScript Document
$(() => {
  //自URL
  var href = location.href.split('?');

  //.doAct以下の自リンク削除
  $('.doAct a').each(function () {
    _c = $(this).attr('class');

    if (href[0] == this.href) {
      $(this).replaceWith($('<span class="' + _c + ' act" />').html($(this).html()));
    }
  });
});
