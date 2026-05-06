/**
 * ==========================================
 * File: IO.gs - スプレッドシート・ドライブ連携
 * ==========================================
 */

// --- 新規追加: インポート時の正規ID割り当て用のリスト構築 ---
function buildExpectedLessonsForImport(state) {
    let lessons = [];
    const teacherMap = {}; (state.teachers||[]).forEach(t => teacherMap[t.id] = t.name);
    const roomObj = {}; (state.rooms||[]).forEach(r => roomObj[r.name] = r);
    const rules = state.advancedRules || {};

    if (state.specialBlocks) {
      state.specialBlocks.forEach(b => {
        let tMap = {}; (b.teachers||[]).forEach(t => tMap[t.id] = parseInt(t.hours)||0);
        let fTimes = (b.fixedTimes || []).slice();
        for (let i=0; i<b.hours; i++) {
          let tIds = []; (b.teachers||[]).forEach(t => { if(tMap[t.id]>0) { tIds.push(t.id); tMap[t.id]--; }});
          let fTime = fTimes.length > 0 ? fTimes.shift() : null;
          lessons.push({ id:`sp_${b.id}_${i}`, subjectId:b.subjectId, subject:state.subjects.find(s=>s.id===b.subjectId)?.name||'特殊', targets:b.targets||[], teacherIds:tIds, teacherName:tIds.map(id=>teacherMap[id]||'').join(','), room:b.room||'通常教室', isSpecialist:true, length:1, totalHours:b.hours, type:'special', limitOnePerDay: b.limitOnePerDay === true, isFixed: !!fTime, fixedTime: fTime });
        }
      });
    }
    if (state.classAssignments) {
      Object.keys(state.classAssignments).forEach(cls => {
        const grade = cls.split('-')[0], data = state.classAssignments[cls];
        (state.subjects||[]).forEach(sub => {
          let stdHrs = parseInt(sub.stdHours?.[grade])||0; if(stdHrs === 0) return;
          let specialHrs = 0; if (state.specialBlocks) { state.specialBlocks.forEach(b => { if (b.subjectId === sub.id && (b.targets||[]).includes(cls)) specialHrs += (parseInt(b.hours) || 0); }); }
          let remainingHrs = stdHrs - specialHrs; if (remainingHrs <= 0) return;
          const ovr = data.overrides?.[sub.id] || {}, rName = ovr.room || sub.defaultRoom || '通常教室';
          const isCont = rules.continuousClasses?.some(rc => rc.subject === sub.name && matchRuleTarget(rc, { targets: [cls] }));
          let fTimes = (ovr.fixedTimes || []).slice();
          const proc = (tId, h, aIdx) => {
            if(!tId) return; 
            const isSp = (roomObj[rName] || tId !== data.homeroom);
            let localH = h;
            while(localH > 0 && fTimes.length > 0) {
              let fTime = fTimes.shift();
              lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_f${localH}`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: !!fTime, fixedTime: fTime });
              localH--;
            }
            if (isCont && localH >= 2) {
              for(let i=0; i<Math.floor(localH/2); i++) lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_p${i}`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:2, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: false });
              if(localH%2 !== 0) lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_s0`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: false });
            } else {
              for(let i=0; i<localH; i++) lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_${i}`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: false });
            }
          };
          if (ovr.allocations?.length > 0) ovr.allocations.forEach((a,i) => proc(a.teacherId, parseInt(a.hours)||0, i)); else proc(ovr.teacherId||data.homeroom, remainingHrs, 0);
        });
      });
    }
    return lessons;
}

function handleImportFromSS(url, state) {
  try {
    const idMatch = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return { success: false, message: "無効なスプレッドシートURLです。URLを確認してください。" };
    
    const ssId = idMatch[1];
    const ss = SpreadsheetApp.openById(ssId);
    
    const sheet = ss.getSheetByName("全体(クラス)");
    if (!sheet) return { success: false, message: "対象の「全体(クラス)」シートが見つかりません。エクスポート時のシート名を確認してください。" };

    const range = sheet.getDataRange();
    const values = range.getDisplayValues(); 
    if (values.length < 3) return { success: false, message: "シートにデータが存在しません。" };

    const { DAYS, PERIODS } = getDynamicDaysAndPeriods(state);
    
    let importedSchedule = {};
    DAYS.forEach(d => {
      importedSchedule[d] = {};
      PERIODS.forEach(p => importedSchedule[d][p] = []);
    });

    let errorLog = [];
    let importCount = 0;

    const dayRow = values[0];
    const periodRow = values[1];
    const colMap = {}; 

    let currentDay = "";
    for (let c = 1; c < dayRow.length; c++) {
      if (dayRow[c] !== "") currentDay = dayRow[c].replace("曜", "").trim();
      let pStr = periodRow[c];
      if (currentDay && pStr) {
        colMap[c] = { day: currentDay, period: parseInt(pStr, 10) };
      }
    }

    const teacherNameMap = {};
    (state.teachers || []).forEach(t => teacherNameMap[t.name.trim()] = t.id);

    const subjectMap = {};
    (state.subjects || []).forEach(s => subjectMap[s.name.trim()] = s.id);

    // 一旦、スプレッドシートの記述通りに仮の駒を生成・マージする
    for (let r = 2; r < values.length; r++) {
      const row = values[r];
      const clsName = row[0] ? row[0].toString().trim() : "";
      if (!clsName) continue;

      for (let c = 1; c < row.length; c++) {
        const cellValue = row[c] ? row[c].toString().trim() : "";
        if (!cellValue) continue;

        const cellInfo = colMap[c];
        if (!cellInfo) continue;

        const lines = cellValue.split('\n').map(l => l.trim());
        if (lines[0] === "重") continue;

        const subjectName = lines[0];
        const subId = subjectMap[subjectName];
        if (!subId) {
          errorLog.push(`${clsName}の${cellInfo.day}曜${cellInfo.period}限: 教科「${subjectName}」が未登録です。`);
          continue;
        }

        const teacherName = lines.length > 1 ? lines[1] : '';
        let tIds = [];
        if (teacherName) {
           const names = teacherName.split(',').map(n => n.trim());
           names.forEach(n => {
             if (teacherNameMap[n]) tIds.push(teacherNameMap[n]);
             else errorLog.push(`${clsName}の${cellInfo.day}曜: 教員「${n}」が見つかりません。`);
           });
        }
        
        const teacherIdsStr = tIds.slice().sort().join(',');

        let existingLesson = importedSchedule[cellInfo.day][cellInfo.period].find(
            l => l.subjectId === subId && l.teacherIds.slice().sort().join(',') === teacherIdsStr
        );

        if (existingLesson) {
            // 合同授業等の場合、ターゲットを追加
            if (!existingLesson.targets.includes(clsName)) {
                existingLesson.targets.push(clsName);
            }
        } else {
            // 仮のIDで登録
            const lessonId = `tmp_${subId}_${clsName}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const importedLesson = {
              id: lessonId,
              subjectId: subId,
              subject: subjectName,
              targets: [clsName],
              teacherIds: tIds.length > 0 ? tIds : [state.classAssignments?.[clsName]?.homeroom].filter(Boolean),
              teacherName: teacherName,
              room: state.subjects.find(s => s.id === subId)?.defaultRoom || '通常教室',
              isSpecialist: tIds.some(tid => tid !== state.classAssignments?.[clsName]?.homeroom),
              length: 1, 
              totalHours: 1,
              type: 'normal',
              limitOnePerDay: false,
              isFixed: true, 
              isLocked: true 
            };
            importedSchedule[cellInfo.day][cellInfo.period].push(importedLesson);
        }
      }
    }

    // --- 既存の同期ロジックとの互換性確保 ---
    // 生成した仮のスケジュールに対して、設定に基づく正規のIDを割り当てる
    const availableLessons = buildExpectedLessonsForImport(state);

    DAYS.forEach(d => {
      PERIODS.forEach(p => {
        importedSchedule[d][p].forEach(l => {
          let bestMatchIdx = -1;
          
          // 1. 対象クラスと教科が完全一致するものを探す（特殊・合同授業など）
          bestMatchIdx = availableLessons.findIndex(al => 
            al.subjectId === l.subjectId && 
            al.targets.slice().sort().join(',') === l.targets.slice().sort().join(',')
          );

          // 2. なければ、代表クラス（targets[0]）と教科が一致するものを探す
          if (bestMatchIdx === -1) {
            bestMatchIdx = availableLessons.findIndex(al => 
              al.subjectId === l.subjectId && 
              al.targets.includes(l.targets[0])
            );
          }

          if (bestMatchIdx > -1) {
            // 正規IDと属性を適用（これによりフロントエンドでの同期が破綻しない）
            l.id = availableLessons[bestMatchIdx].id;
            availableLessons.splice(bestMatchIdx, 1); // 割り当て済みの枠を消費
            importCount++;
          } else {
            // 設定にない、あるいは設定のコマ数を超過している授業
            errorLog.push(`${l.targets.join(',')}の${d}曜${p}限: 「${l.subject}」は設定コマ数を超過しているか、未登録のパターンです。(同期時に消去される可能性があります)`);
          }
        });
      });
    });

    return { 
      success: true, 
      schedule: importedSchedule, 
      importCount: importCount, 
      errors: errorLog,
      message: `スプレッドシートから ${importCount} 件のコマを正規IDで読み込みました。` 
    };

  } catch (e) {
    return { success: false, message: "インポートエラー: " + e.message };
  }
}

function handleExport(schedule, data, options) {
  try {
    const timestamp = Utilities.formatDate(new Date(), "JST", "yyyyMMdd_HHmm");
    const ssName = `時間割データ_${timestamp}`;
    const ss = SpreadsheetApp.create(ssName);
    
    let pdfOpts = options.pdf || {};
    let ssOpts = options.spreadsheet || {};
    if (!options.pdf && !options.spreadsheet) {
        ssOpts = { matrixClass: true, individualClass: true };
    }

    const reqMatrixClass = ssOpts.matrixClass || pdfOpts.matrixClass;
    const reqMatrixTeacher = ssOpts.matrixTeacher || pdfOpts.matrixTeacher;
    const reqMatrixRoom = ssOpts.matrixRoom || pdfOpts.matrixRoom;
    const reqIndivClass = ssOpts.individualClass || pdfOpts.individualClass;
    const reqIndivTeacher = ssOpts.individualTeacher || pdfOpts.individualTeacher;

    const defaultSheet = ss.getSheets()[0];
    let hasSheet = false;
    
    if (reqMatrixClass) { createMatrixSheet(ss, `全体(クラス)`, schedule, data, 'class'); hasSheet = true; }
    if (reqMatrixTeacher) { createMatrixSheet(ss, `全体(教員)`, schedule, data, 'teacher'); hasSheet = true; }
    if (reqMatrixRoom) { createMatrixSheet(ss, `全体(教室)`, schedule, data, 'room'); hasSheet = true; }
    if (reqIndivClass) { createIndividualSheet(ss, `各クラス`, schedule, data, 'class'); hasSheet = true; }
    if (reqIndivTeacher) { createIndividualSheet(ss, `各教員`, schedule, data, 'teacher'); hasSheet = true; }

    if (hasSheet) ss.deleteSheet(defaultSheet);
    
    SpreadsheetApp.flush();

    let resultUrls = {};
    let wantsSpreadsheet = Object.keys(ssOpts).length > 0 && Object.values(ssOpts).some(v => v);
    let wantsPdf = Object.keys(pdfOpts).length > 0 && Object.values(pdfOpts).some(v => v);
    
    let targetFolder = DriveApp.getRootFolder();
    if (options.folderId) {
        try {
            targetFolder = DriveApp.getFolderById(options.folderId);
        } catch(e) {
            console.log("Folder access error, falling back to root.");
        }
    }

    const ssFile = DriveApp.getFileById(ss.getId());

    if (wantsPdf) {
        const url = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?exportFormat=pdf&format=pdf&size=A3&portrait=false&fitw=true&top_margin=0.5&bottom_margin=0.5&left_margin=0.5&right_margin=0.5&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false`;
        const token = ScriptApp.getOAuthToken();
        const response = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
        const pdfBlob = response.getBlob().setName(`${ssName}.pdf`);
        const pdfFile = targetFolder.createFile(pdfBlob);
        resultUrls.pdfUrl = pdfFile.getDownloadUrl() || pdfFile.getUrl();
    }

    if (wantsSpreadsheet) {
        ssFile.moveTo(targetFolder);
        resultUrls.spreadsheetUrl = ssFile.getUrl();
    } else if (wantsPdf) {
        ssFile.setTrashed(true);
    }
    
    return { success: true, urls: resultUrls };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function createMatrixSheet(ss, sheetName, schedule, data, type) {
  const { DAYS, PERIODS } = getDynamicDaysAndPeriods(data);
  const sheet = ss.insertSheet(sheetName);
  
  let rows = [];
  if (type === 'class') {
    Object.keys(data.grades).forEach(g => {
      for (let c = 1; c <= data.grades[g]; c++) rows.push({id: `${g}-${c}`, name: `${g}-${c}`});
    });
  } else if (type === 'teacher') {
    rows = (data.teachers || []).map(t => ({id: t.id, name: t.name}));
  } else if (type === 'room') {
    rows = (data.rooms || []).map(r => ({id: r.name, name: r.name}));
  }

  const totalCols = 1 + DAYS.length * PERIODS.length;
  const totalRows = rows.length + 2;

  sheet.getRange(1, 1, totalRows, totalCols).setNumberFormat("@");

  let headerRow1 = ["軸 \\ 曜日"];
  let headerRow2 = ["時限"];
  DAYS.forEach(d => {
    for(let i=0; i<PERIODS.length; i++) headerRow1.push(i===0 ? `${d}曜` : "");
    PERIODS.forEach(p => headerRow2.push(p));
  });
  
  sheet.getRange(1, 1, 1, totalCols).setValues([headerRow1]).setFontWeight("bold").setBackground("#e2e8f0").setHorizontalAlignment("center").setFontSize(9);
  sheet.getRange(2, 1, 1, totalCols).setValues([headerRow2]).setFontWeight("bold").setBackground("#f8fafc").setHorizontalAlignment("center").setFontSize(9);
  
  let c = 2;
  DAYS.forEach(d => {
    if (PERIODS.length > 1) sheet.getRange(1, c, 1, PERIODS.length).merge();
    c += PERIODS.length;
  });

  let backgrounds = [];
  let gridValues = [];
  
  rows.forEach(item => {
    let rowData = [item.name];
    let rowColors = ["#ffffff"];
    DAYS.forEach(d => {
      PERIODS.forEach(p => {
        let cellText = "", cellColor = "#ffffff";
        if (schedule[d] && schedule[d][p]) {
          let targetLessons = [];
          if (type === 'class') targetLessons = schedule[d][p].filter(l => l.targets && l.targets.includes(item.id));
          else if (type === 'teacher') targetLessons = schedule[d][p].filter(l => l.teacherIds && l.teacherIds.includes(item.id));
          else if (type === 'room') targetLessons = schedule[d][p].filter(l => l.room === item.id);
          
          if (targetLessons.length > 0) {
            let l = targetLessons[0];
            if (targetLessons.length > 1) { cellText = "重\n" + l.subject; cellColor = "#ffcdd2"; }
            else {
              let subT = type === 'class' ? (l.teacherName || '') : (l.targets ? l.targets.join(',') : '');
              if (type === 'room') subT = (l.targets ? l.targets.join(',') : '') + " " + (l.teacherName || '');
              cellText = `${l.subject}\n${subT}`;
              cellColor = getSubjectColor(l.subject, data);
            }
          }
        }
        rowData.push(cellText);
        rowColors.push(cellColor);
      });
    });
    gridValues.push(rowData);
    backgrounds.push(rowColors);
  });
  
  if (gridValues.length > 0) {
    sheet.getRange(3, 1, gridValues.length, totalCols).setValues(gridValues).setBackgrounds(backgrounds);
  }
  
  sheet.setRowHeights(3, rows.length, 40);
  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidths(2, totalCols - 1, 45);
  sheet.getRange(1, 1, totalRows, totalCols).setBorder(true, true, true, true, true, true).setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true).setFontSize(8);
  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(1);
}

function createIndividualSheet(ss, sheetName, schedule, data, type) {
  const { DAYS, PERIODS } = getDynamicDaysAndPeriods(data);
  const sheet = ss.insertSheet(sheetName);
  
  let items = [];
  if (type === 'class') {
    Object.keys(data.grades).forEach(g => {
      for (let c = 1; c <= data.grades[g]; c++) items.push(`${g}-${c}`);
    });
  } else if (type === 'teacher') {
    items = (data.teachers || []).map(t => ({id: t.id, name: t.name}));
  }
  
  sheet.getRange("A:Z").setNumberFormat("@");

  let currentRow = 1;
  items.forEach(item => {
    let title = type === 'class' ? `${item} 時間割` : `${item.name} 先生 時間割`;
    let targetId = type === 'class' ? item : item.id;
    
    sheet.getRange(currentRow, 1, 1, DAYS.length + 1).merge().setValue(title).setFontWeight("bold").setFontSize(14).setBackground("#e2e8f0").setHorizontalAlignment("center").setVerticalAlignment("middle");
    currentRow++;
    
    let header = ["時限 \\ 曜日", ...DAYS];
    sheet.getRange(currentRow, 1, 1, DAYS.length + 1).setValues([header]).setFontWeight("bold").setBackground("#f8fafc").setHorizontalAlignment("center").setVerticalAlignment("middle");
    currentRow++;
    
    PERIODS.forEach(p => {
      let rowData = [`${p}限`];
      let rowColors = ["#f8fafc"];
      DAYS.forEach(d => {
        let cellText = "", cellColor = "#ffffff";
        if (schedule[d] && schedule[d][p]) {
          let targets = schedule[d][p].filter(l => l.targets && l.targets.includes(targetId) || (type==='teacher' && l.teacherIds && l.teacherIds.includes(targetId)));
          if (targets.length > 0) {
             let l = targets[0];
             if (targets.length > 1) { cellText = "重複"; cellColor = "#ffcdd2"; }
             else {
                 cellText = type === 'class' ? `${l.subject}\n(${l.teacherName || ''})` : `${l.subject}\n(${l.targets ? l.targets.join(',') : ''})`;
                 cellColor = getSubjectColor(l.subject, data);
             }
          }
        }
        rowData.push(cellText);
        rowColors.push(cellColor);
      });
      sheet.getRange(currentRow, 1, 1, DAYS.length + 1).setValues([rowData]).setBackgrounds([rowColors]).setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true).setFontSize(10);
      currentRow++;
    });
    sheet.getRange(currentRow - PERIODS.length - 2, 1, PERIODS.length + 2, DAYS.length + 1).setBorder(true, true, true, true, true, true);
    sheet.setRowHeights(currentRow - PERIODS.length, PERIODS.length, 60); 
    currentRow += 2;
  });
}