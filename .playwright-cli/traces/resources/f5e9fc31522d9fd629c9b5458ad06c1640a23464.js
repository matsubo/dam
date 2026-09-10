/* JSON Data Get */
$(document).ready(() => {
  jsonDataGet();
});

function jsonDataGet() {
  $.getJSON(menuconfig, (data) => {
    const tabmap = new Map();
    for (var i in data) {
      if (data[i].tab) {
        tabmap.set(data[i].key, data[i].tab);
      }
    }

    for (let cnt = 0; cnt < tabs.length; cnt++) {
      let tabobj = new Object();
      tabobj = tabmap.get(tabs[cnt]);
      for (let i = 0; i < tabobj.length; i++) {
        // Set JSON data into localStorage
        var jsonhref = tabobj[i].url.split('?');
        localStorage.setItem(tabobj[i].urlid, jsonhref[0]); // url
        localStorage.setItem('title_' + tabobj[i].urlid, tabobj[i].title); // title
        localStorage.setItem('grpid_' + tabobj[i].urlid, tabobj[i].grpid); // grpid
        localStorage.setItem('pg_' + tabobj[i].urlid, tabobj[i].pg); // pg
        localStorage.setItem('ktm_' + tabobj[i].urlid, tabobj[i].ktm); // ktm
        localStorage.setItem('kra_' + tabobj[i].urlid, tabobj[i].kra); // kra
        localStorage.setItem('grpid_value_' + tabobj[i].urlid, tabobj[i].grpid_value); // grpid_value
        localStorage.setItem('pg_value_' + tabobj[i].urlid, tabobj[i].pg_value); // pg_value

        // Menu selection settings
        document.getElementById(tabobj[i].urlid).href = tabobj[i].url; // Menu URL Set
        document.getElementById(tabobj[i].urlid).textContent = tabobj[i].title; // Menu Sub Title Set
        if (tabobj[i].urlid.indexOf(suburlget()) != -1) {
          // URL Pass Get
          let dispurl = tabobj[i].url;
          // "groupID" setup process
          if (localStorage.getItem('grpid_' + suburlget()) == 'true') {
            const grpidvalue = localStorage.getItem('grpid_value_' + tabobj[i].urlid);
            const grpidvalues = grpidvalue.split(',');
            const grpidvalueid = grpidvalues[0].split(':');
            // grpId or myMenuId ?
            if (tabobj[i].urlid != g_url_05_00) dispurl = dispurl + '&grpId=' + grpidvalueid[0];
            else dispurl = dispurl + '&myMenuId=' + grpidvalueid[0];
          }
          // "PG" setup process
          if (localStorage.getItem('pg_' + suburlget()) == 'true') {
            dispurl = dispurl + '&PG=1';
          }
          // "KTM" setup process
          if (localStorage.getItem('ktm_' + suburlget()) == 'true') {
            const ktmno = localStorage.getItem('ktm');
            let KTM = '&KTM=1';
            if (ktmno == 3) KTM = '&KTM=3';
            dispurl = dispurl + KTM;
          }
          // "KRA" setup process
          if (localStorage.getItem('kra_' + suburlget()) == 'true') {
            const krano = localStorage.getItem('kra');
            let KRA = '&KRA=5';
            if (krano == 13) KRA = '&KRA=13';
            dispurl = dispurl + KRA;
          }

          // Freame URL set
          //document.getElementById('ifreame').src = tabobj[i].url;
          document.getElementById('ifreame').src = dispurl;
          //console.log("menuconfig dispurl["+dispurl+"]");
          // Gamen Name Set
          document.getElementById('gamenname').textContent = tabobj[i].title;

          // Display Control
          operation(tabobj[i].urlid);

          // SelectBox Delete
          const selectbox = document.getElementById('grpipdselect');
          if (selectbox.childNodes.length > 0) {
            selectbox.removeChild(selectbox.childNodes[0]);
          }

          // "grpId" SelectBox Set
          if (localStorage.getItem('grpid_' + tabobj[i].urlid) == 'true') {
            localStorage.setItem('urlid', tabobj[i].urlid);

            const grpidvalue = localStorage.getItem('grpid_value_' + tabobj[i].urlid);
            const grpidvalues = grpidvalue.split(',');

            const jsSelectBox = document.querySelector('.grpipdselect');
            const selectWrap = document.createElement('div');
            selectWrap.classList.add('selectwrap');
            selectWrap.id = 'selectwrap';
            const select = document.createElement('select');
            select.setAttribute('name', 'grpid');
            select.classList.add('grpselect');
            for (const elem of grpidvalues) {
              const option = document.createElement('option');
              const grps = elem.split(':');
              option.value = grps[0];
              option.textContent = grps[1];
              select.appendChild(option);
            }
            selectWrap.appendChild(select);
            jsSelectBox.appendChild(selectWrap);
          }

          // "grpId" SelectBox Set
          if (localStorage.getItem('pg_' + tabobj[i].urlid) == 'true') {
            const pgvalue = localStorage.getItem('pg_value_' + tabobj[i].urlid);
            const pgvalues = pgvalue.split(',');
            document.getElementById('textbox').textContent = 1; //init
            document.getElementById('pagemax').textContent = pgvalues[0];
            localStorage.setItem('grpidvalueorg', pgvalue);
            // Initial setting
            const grpidvalue = localStorage.getItem('grpid_value_' + tabobj[i].urlid);
            const grpidvalues = grpidvalue.split(',');
            const grpidvalueid = grpidvalues[0].split(':');
            localStorage.setItem('groupid', grpidvalueid[0]);
          }
        }
      }
      //console.log("menuconfig end");
    }
    // Click Proces
    grpidClick();
    ktmClick();
    kraClick();
  });
}
