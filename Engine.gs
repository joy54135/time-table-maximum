/**
 * ==========================================
 * File: Engine.gs - SA-LNS 探索エンジン
 * ==========================================
 */

function generateSchedule(state, currentSchedule, currentUnassigned) {
  const startTime = Date.now();
  const TIME_LIMIT = 22000;
  const { DAYS, PERIODS } = getDynamicDaysAndPeriods(state);
  const teacherObj = {}; (state.teachers||[]).forEach(t => teacherObj[t.id] = t);
  const teacherMap = {}; (state.teachers||[]).forEach(t => teacherMap[t.id] = t.name);
  const roomObj = {}; (state.rooms||[]).forEach(r => roomObj[r.name] = r);
  const rules = state.advancedRules || {}; const pLevels = rules.priorities || {};

  let schedule = {};
  let unassigned = [];
  let reportDetails = {};
  let failStats = {}; 
  let hasFatalError = false;
  let freeLessons = [];

  if (!currentSchedule || !currentUnassigned) {
    let lessons = [];
    // 特殊授業（合同・分割）のパース（端数対応）
    if (state.specialBlocks) {
      state.specialBlocks.forEach(b => {
        let tMap = {}; (b.teachers||[]).forEach(t => tMap[t.id] = parseFloat(t.hours)||0);
        let fTimes = (b.fixedTimes || []).slice();
        let bHours = parseFloat(b.hours) || 0;
        let bWhole = Math.floor(bHours);
        let bFrac = bHours - bWhole;

        for (let i=0; i<Math.ceil(bHours); i++) {
          let tIds = []; (b.teachers||[]).forEach(t => { if(tMap[t.id]>0) { tIds.push(t.id); tMap[t.id]--; }});
          let fTime = fTimes.length > 0 ? fTimes.shift() : null;
          let isFrac = (i === bWhole && bFrac > 0);
          lessons.push({ id:`sp_${b.id}_${i}`, subjectId:b.subjectId, subject:state.subjects.find(s=>s.id===b.subjectId)?.name||'特殊', targets:b.targets||[], teacherIds:tIds, teacherName:tIds.map(id=>teacherMap[id]||'').join(','), room:b.room||'通常教室', isSpecialist:true, length:1, totalHours:b.hours, type:'special', limitOnePerDay: b.limitOnePerDay === true, isFixed: !!fTime, fixedTime: fTime, isFraction: isFrac });
        }
      });
    }
    // 通常授業のパース（端数対応）
    if (state.classAssignments) {
      Object.keys(state.classAssignments).forEach(cls => {
        const grade = cls.split('-')[0], data = state.classAssignments[cls];
        state.subjects.forEach(sub => {
          let stdHrs = parseFloat(sub.stdHours?.[grade])||0; if(stdHrs <= 0) return;
          let specialHrs = 0; if (state.specialBlocks) { state.specialBlocks.forEach(b => { if (b.subjectId === sub.id && (b.targets||[]).includes(cls)) specialHrs += (parseFloat(b.hours) || 0); }); }
          let remainingHrs = stdHrs - specialHrs; if (remainingHrs <= 0) return;
          const ovr = data.overrides?.[sub.id] || {}, rName = ovr.room || sub.defaultRoom || '通常教室';
          const isCont = rules.continuousClasses?.some(rc => rc.subject === sub.name && matchRuleTarget(rc, { targets: [cls] }));
          let fTimes = (ovr.fixedTimes || []).slice();
          const proc = (tId, h, aIdx) => {
            if(!tId) return; 
            const isSp = (roomObj[rName] || tId !== data.homeroom);
            let localH = parseFloat(h);
            let wholeH = Math.floor(localH);
            let fracH = localH - wholeH;
            
            while(wholeH > 0 && fTimes.length > 0) {
              let fTime = fTimes.shift();
              lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_f${wholeH}`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: !!fTime, fixedTime: fTime });
              wholeH--;
            }
            if (isCont && wholeH >= 2) {
              for(let i=0; i<Math.floor(wholeH/2); i++) lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_p${i}`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:2, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: false });
              if(wholeH%2 !== 0) lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_s0`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: false });
            } else {
              for(let i=0; i<wholeH; i++) lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_${i}`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: false });
            }
            // 端数コマの追加生成
            if (fracH > 0) {
              let fTime = fTimes.length > 0 ? fTimes.shift() : null;
              lessons.push({ id:`n_${cls}_${sub.id}_a${aIdx}_frac`, subjectId:sub.id, subject:sub.name, targets:[cls], teacherIds:[tId], teacherName:teacherMap[tId]||'', room:rName, isSpecialist:isSp, length:1, totalHours:remainingHrs, type:'normal', limitOnePerDay: false, isFixed: !!fTime, fixedTime: fTime, isFraction: true });
            }
          };
          if (ovr.allocations?.length > 0) ovr.allocations.forEach((a,i) => proc(a.teacherId, a.hours, i)); else proc(ovr.teacherId||data.homeroom, remainingHrs, 0);
        });
      });
    }

    DAYS.forEach(d => { schedule[d] = {}; PERIODS.forEach(p => schedule[d][p] = []); });
    let fixedLessons = lessons.filter(l => l.isFixed);
    freeLessons = lessons.filter(l => !l.isFixed);
    
    for (let fl of fixedLessons) {
      if(!fl.fixedTime) continue;
      let [fd, fpStr] = fl.fixedTime.split('-');
      let fp = parseInt(fpStr);
      let grade = fl.targets[0].split('-')[0], physicalOk = true, reason = "";
      if (fp > (state.periods[grade]?.[fd]||0)) { physicalOk = false; reason = "時限超過"; }
      else if (state.globalBlocks && state.globalBlocks[`${fd}-${fp}`]) { physicalOk = false; reason = "全校不可枠"; }
      else if (fl.teacherIds.some(tid => teacherObj[tid]?.ngTimes?.[`${fd}-${fp}`])) { physicalOk = false; reason = "教員✕枠"; }
      else if (fl.room && roomObj[fl.room]) {
        const cap = roomObj[fl.room].capacity || 1;
        const count = (schedule[fd] && schedule[fd][fp]) ? schedule[fd][fp].filter(l => l.room === fl.room).length : 0;
        if (count >= cap) { physicalOk = false; reason = `特別教室(${fl.room})定員`; }
      }
      if (!physicalOk) {
        hasFatalError = true;
        reportDetails[`${fl.targets.join(',')}_${fl.subject}`] = { target: fl.targets.join(','), subject: fl.subject, causes: [{ type: "ピン留め矛盾", detail: `「${fd}${fp}固定」が${reason}により配置不可。`, impact: 100 }] };
      } else {
          if(!schedule[fd]) schedule[fd] = {};
          if(!schedule[fd][fp]) schedule[fd][fp] = [];
          schedule[fd][fp].push(fl);
      }
    }
    if (hasFatalError) return { schedule, unassigned: lessons, isComplete: false, reportDetails, fatalError: true, scoreCard: null };

  } else {
    schedule = JSON.parse(JSON.stringify(currentSchedule));
    let tempUnassigned = JSON.parse(JSON.stringify(currentUnassigned));
    DAYS.forEach(d => {
      PERIODS.forEach(p => {
        if (schedule[d] && schedule[d][p]) {
          let kept = [];
          schedule[d][p].forEach(l => {
            if (l.isLocked || l.isFixed) { l.isFixed = true; kept.push(l); }
            else { if (!freeLessons.some(fl => fl.id === l.id)) freeLessons.push(l); }
          });
          schedule[d][p] = kept;
        }
      });
    });
    if (tempUnassigned) { tempUnassigned.forEach(l => { if (!freeLessons.some(fl => fl.id === l.id)) freeLessons.push(l); }); }
  }

  freeLessons.sort((a,b) => getLessonDifficulty(b, teacherObj, roomObj) - getLessonDifficulty(a, teacherObj, roomObj));
  for (let lesson of freeLessons) {
    let placed = false, candidates = []; DAYS.forEach(d => PERIODS.forEach(p => candidates.push({d, p}))); 
    
    // 【新機能】不安定枠(☁)に対する初期配置の優先度調整
    candidates.sort(() => Math.random() - 0.5);
    candidates.sort((a,b) => {
        let aUn = (state.unstableBlocks && state.unstableBlocks[`${a.d}-${a.p}`]) ? 1 : 0;
        let bUn = (state.unstableBlocks && state.unstableBlocks[`${b.d}-${b.p}`]) ? 1 : 0;
        return lesson.isFraction ? (bUn - aUn) : (aUn - bUn); // 端数は優先、通常は回避
    });

    for (let {d, p} of candidates) {
      if (p + (lesson.length||1) - 1 > Math.max(...PERIODS)) continue;
      let can = true;
      for (let i=0; i<(lesson.length||1); i++) {
        const g = lesson.targets[0].split('-')[0];
        if (p+i > (state.periods[g]?.[d]||0) || (state.globalBlocks && state.globalBlocks[`${d}-${p+i}`]) || lesson.teacherIds.some(tid => teacherObj[tid]?.ngTimes?.[`${d}-${p+i}`])) { can = false; break; }
        if (schedule[d][p+i] && schedule[d][p+i].some(l => l.targets.some(t => lesson.targets.includes(t)) || l.teacherIds.some(tid => lesson.teacherIds.includes(tid)))) { can = false; break; }
        if (lesson.room && roomObj[lesson.room]) {
          const cap = roomObj[lesson.room].capacity || 1;
          const currentCount = (schedule[d][p+i] || []).filter(l => l.room === lesson.room).length;
          if (currentCount >= cap) { can = false; break; }
        }
      }
      if (can) { const strictRes = checkStrictRules(lesson, d, p, schedule, state, rules, pLevels, PERIODS); if (!strictRes.valid) can = false; }
      if (can) { 
          for(let i=0; i<(lesson.length||1); i++) {
              if(!schedule[d][p+i]) schedule[d][p+i] = [];
              schedule[d][p+i].push(lesson); 
          }
          placed = true; break; 
      }
    }
    if (!placed) unassigned.push(lesson);
  }

  let loopCount = 0, stuckCounter = 0, minUnassigned = unassigned.length, penaltyMap = {}; 
  while (unassigned.length > 0 && (Date.now() - startTime) < TIME_LIMIT) {
    loopCount++; 
    const progress = (Date.now() - startTime) / TIME_LIMIT;
    if (unassigned.length < minUnassigned) { minUnassigned = unassigned.length; stuckCounter = 0; } else { stuckCounter++; }

    if (minUnassigned > 0 && stuckCounter > 120 && progress < 0.85) {
      stuckCounter = 0;
      let allPlaced = [];
      DAYS.forEach(d => PERIODS.forEach(p => { (schedule[d]?.[p]||[]).forEach(l => { if (!l.isFixed && !l.isLocked && !allPlaced.some(pl=>pl.id===l.id)) allPlaced.push(l); }); }));
      allPlaced.sort(() => Math.random() - 0.5);
      let destroyCount = Math.floor(Math.random() * 6) + 5;
      for(let i=0; i<Math.min(destroyCount, allPlaced.length); i++) { removeLesson(allPlaced[i], schedule); unassigned.push(allPlaced[i]); }
      continue; 
    } else if (stuckCounter > 250) { break; }

    unassigned.sort((a,b) => (getLessonDifficulty(b, teacherObj, roomObj) + (penaltyMap[b.id]||0)) - (getLessonDifficulty(a, teacherObj, roomObj) + (penaltyMap[a.id]||0)));
    const target = unassigned.shift(), len = target.length || 1;
    penaltyMap[target.id] = (penaltyMap[target.id] || 0) + 50;

    let bestMoves = []; const searchGrid = []; DAYS.forEach(d => PERIODS.forEach(p => searchGrid.push({d, p}))); searchGrid.sort(() => Math.random() - 0.5);
    for (let {d, p} of searchGrid) {
      if (p + len - 1 > Math.max(...PERIODS)) continue;
      let canPlaceBase = true, conflicts = [];
      const strictRes = checkStrictRules(target, d, p, schedule, state, rules, pLevels, PERIODS);
      if (!strictRes.valid) canPlaceBase = false;
      if (canPlaceBase) {
        for (let i=0; i<len; i++) {
          let currP = p + i, g = target.targets[0].split('-')[0];
          if (currP > (state.periods[g]?.[d]||0) || state.globalBlocks[`${d}-${currP}`] || target.teacherIds.some(tid => teacherObj[tid]?.ngTimes?.[`${d}-${currP}`])) { canPlaceBase = false; break; }
          (schedule[d]?.[currP]||[]).forEach(ex => {
            if (target.teacherIds.some(tid => ex.teacherIds.includes(tid)) || target.targets.some(tgt => ex.targets.includes(tgt)) || (target.room && roomObj[target.room] && target.room === ex.room)) {
              if (ex.isFixed || ex.isLocked) canPlaceBase = false; else if (!conflicts.some(c => c.id === ex.id)) conflicts.push(ex);
            }
          });
        }
      }
      if (!canPlaceBase || conflicts.length > (progress < 0.8 ? 3 : 2)) continue;
      let penalty = 0; for (let i=0; i<len; i++) penalty += calcRulePenalty(target, d, p+i, schedule, state, rules, pLevels, PERIODS);
      bestMoves.push({ d, p, conflicts, score: (conflicts.length * 20000) + penalty + (Math.random() * 50) });
    }
    if (bestMoves.length === 0) { unassigned.push(target); continue; }
    bestMoves.sort((a,b) => a.score - b.score); 
    let chosen = bestMoves[0];
    let toRemove = [...chosen.conflicts];
    toRemove.forEach(c => { removeLesson(c, schedule); unassigned.push(c); });
    for(let i=0; i<len; i++) { if(!schedule[chosen.d][chosen.p+i]) schedule[chosen.d][chosen.p+i] = []; schedule[chosen.d][chosen.p+i].push(target); }
  }
  const scoreCard = evaluateSchedule(schedule, state, rules, pLevels, unassigned, teacherObj, DAYS, PERIODS);
  return { schedule, unassigned, isComplete: (unassigned.length === 0), reportDetails, fatalError: hasFatalError, scoreCard };
}

function evaluateSchedule(schedule, state, rules, pLevels, unassigned, teacherObj, DAYS, PERIODS) {
  const scoreCard = { basic: { score: 100, details: [] }, advanced: { score: 100, rules: {} } };
  let scheduledCount = 0; let unassignedCount = unassigned.length;
  
  const allScheduledLessons = [];
  const lessonSet = new Set();
  DAYS.forEach(d => PERIODS.forEach(p => { 
      (schedule[d]?.[p]||[]).forEach(l => { 
          if (!lessonSet.has(l.id)) {
              lessonSet.add(l.id);
              allScheduledLessons.push({ lesson: l, day: d, period: p });
          }
      }); 
  }));
  scheduledCount = lessonSet.size;
  
  let total = scheduledCount + unassignedCount;
  if (total > 0) scoreCard.basic.score = Math.round((scheduledCount / total) * 100);
  if (unassignedCount > 0) scoreCard.basic.details.push(`${unassignedCount}コマが未配置です。`);
  else scoreCard.basic.details.push(`全 ${scheduledCount} コマの配置を完了しました。`);

  const classSchedules = {};
  if (state.classAssignments) {
    Object.keys(state.classAssignments).forEach(cls => {
      classSchedules[cls] = {};
      DAYS.forEach(d => {
        classSchedules[cls][d] = [];
        PERIODS.forEach(p => { if (schedule[d] && schedule[d][p]) { const lessons = schedule[d][p].filter(l => l.targets.includes(cls)); if (lessons.length > 0) classSchedules[cls][d].push({ period: p, lessons }); } });
      });
    });
  }

  const evalRule = (key, name, logic) => {
    const res = logic();
    let score = 100;
    if (res.targetCount > 0) score = Math.max(0, Math.round((1 - res.failures.length / res.targetCount) * 100));
    scoreCard.advanced.rules[key] = { name, score, failures: res.failures };
    return score;
  };

  evalRule('limitOneSubjectPerDayStrict', '1日1コマ制限(分散)', () => {
    let targetCount = 0, failures = [];
    const enforceOnePerDay = pLevels['limitOneSubjectPerDayStrict'] !== 'low';
    Object.keys(classSchedules).forEach(cls => {
      DAYS.forEach(d => {
        const counts = {}; 
        classSchedules[cls][d].forEach(slot => { slot.lessons.forEach(l => { 
            if (!counts[l.subject]) counts[l.subject] = { ids: new Set(), totalHours: l.totalHours, limitOnePerDay: l.limitOnePerDay };
            counts[l.subject].ids.add(l.id);
        }); });
        Object.entries(counts).forEach(([sub, info]) => { 
          if (info.limitOnePerDay || (enforceOnePerDay && info.totalHours <= 5)) {
            targetCount++; 
            if (info.ids.size > 1) {
                failures.push(`${cls} ${sub} が${d}曜に複数回(別コマとして)存在`); 
            }
          }
        });
      });
    });
    return { targetCount, failures };
  });

  if (rules.limitContinuousToSpecificPeriods) {
    evalRule('limitContinuousToSpecificPeriods', '連続授業の特定枠限定', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         if (lesson.length === 2) {
            targetCount++;
            if (period !== 1 && period !== 3 && period !== 5) failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period}限) がペア枠外`);
         }
      });
      return { targetCount, failures };
    });
  }

  if (rules.exclusivePairs && rules.exclusivePairs.length > 0) {
    evalRule('exclusivePairs', '同日実施回避(排他ペア)', () => {
      let targetCount = 0, failures = [];
      Object.keys(classSchedules).forEach(cls => {
        DAYS.forEach(d => {
           const todaySubjects = new Set();
           classSchedules[cls][d].forEach(slot => slot.lessons.forEach(l => todaySubjects.add(l.subject)));
           rules.exclusivePairs.forEach(pair => {
             targetCount++; 
             if (todaySubjects.has(pair.subject1) && todaySubjects.has(pair.subject2)) failures.push(`${cls} ${pair.subject1}と${pair.subject2} が${d}曜に同日実施`);
           });
        });
      });
      return { targetCount, failures };
    });
  }

  if (rules.homeroomOnlyTimes && rules.homeroomOnlyTimes.length > 0) {
    evalRule('homeroomOnlyTimes', '担任授業固定枠', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         if (lesson.isSpecialist) {
            for(let i=0; i<(lesson.length||1); i++){
                if (rules.homeroomOnlyTimes.some(r => r.day === day && r.period === (period+i) && matchRuleTarget(r, lesson))) {
                    failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period+i}限) が担任固定枠に配置`);
                }
            }
         }
      });
      targetCount = failures.length > 0 ? failures.length * 2 : 1; 
      return { targetCount, failures };
    });
  }

  if (rules.avoidSpecialistTimes && rules.avoidSpecialistTimes.length > 0) {
    evalRule('avoidSpecialistTimes', '専科回避指定枠', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         if (lesson.isSpecialist) {
            targetCount++;
            for(let i=0; i<(lesson.length||1); i++){
               if (rules.avoidSpecialistTimes.some(r => r.day === day && r.period === (period+i))) failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period+i}限) が専科回避枠に配置`);
            }
         }
      });
      return { targetCount, failures };
    });
  }

  if (rules.avoidSpecificTimes && rules.avoidSpecificTimes.length > 0) {
    evalRule('avoidSpecificTimes', '特定時間帯回避', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         for(let i=0; i<(lesson.length||1); i++){
            if (rules.avoidSpecificTimes.some(r => r.day === day && r.period === (period+i) && r.subject === lesson.subject && matchRuleTarget(r, lesson))) {
               failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period+i}限) が回避指定枠に配置`);
            }
         }
         if (rules.avoidSpecificTimes.some(r => r.subject === lesson.subject && matchRuleTarget(r, lesson))) targetCount++;
      });
      return { targetCount, failures };
    });
  }

  if (rules.amPrioritySubjects && rules.amPrioritySubjects.length > 0) {
    evalRule('amPrioritySubjects', '午前優先配置', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         if (isTargetRule(rules.amPrioritySubjects, lesson)) {
            targetCount++;
            if (period > 4) failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period}限) が午後に配置`);
         }
      });
      return { targetCount, failures };
    });
  }

  if (rules.lastPeriodSubjects && rules.lastPeriodSubjects.length > 0) {
    evalRule('lastPeriodSubjects', '最終コマ優先配置', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         if (isTargetRule(rules.lastPeriodSubjects, lesson)) {
            targetCount++;
            const grade = lesson.targets[0].split('-')[0];
            const maxP = state.periods[grade]?.[day] || Math.max(...PERIODS);
            if (period + (lesson.length||1) - 1 !== maxP) failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period}限) が最終コマ以外に配置`);
         }
      });
      return { targetCount, failures };
    });
  }

  if (rules.homeroomBufferSubjects && rules.homeroomBufferSubjects.length > 0) {
    evalRule('homeroomBufferSubjects', '担任裁量バッファ', () => {
      let targetCount = 0, failures = [];
      allScheduledLessons.forEach(({lesson, day, period}) => {
         if (isTargetRule(rules.homeroomBufferSubjects, lesson)) {
            targetCount++;
            const cls = lesson.targets[0], homeroomId = state.classAssignments?.[cls]?.homeroom;
            if (homeroomId) {
              let bufferOk = false;
              const grade = cls.split('-')[0], maxP = state.periods[grade]?.[day] || Math.max(...PERIODS);
              const checkBuffer = (pNow, pAdj) => {
                if (pAdj < 1 || pAdj > maxP) return false;
                if ((pNow === 4 && pAdj === 5) || (pNow === 5 && pAdj === 4)) return false; 
                const existing = schedule[day][pAdj]?.filter(l => l.targets.includes(cls)) || [];
                if (existing.length === 0) return true; 
                if (existing.some(l => l.teacherIds.includes(homeroomId))) return true; 
                return false;
              };
              if (checkBuffer(period, period - 1) || checkBuffer(period + (lesson.length||1) - 1, period + (lesson.length||1))) bufferOk = true;
              if (!bufferOk) failures.push(`${lesson.targets.join(',')} ${lesson.subject}(${day}曜${period}限) の前後にバッファなし`);
            }
         }
      });
      return { targetCount, failures };
    });
  }

  let advScores = Object.values(scoreCard.advanced.rules).map(r => r.score);
  if (advScores.length > 0) scoreCard.advanced.score = Math.round(advScores.reduce((a,b)=>a+b, 0) / advScores.length);
  return scoreCard;
}

function calcRulePenalty(lesson, d, p, schedule, state, rules, pLevels, PERIODS) {
  let penalty = 0;
  const isHigh = (k, def = false) => pLevels[k] !== undefined ? pLevels[k] === 'high' : def;
  
  // --- 【新機能】不安定枠(☁️) と 非整数(端数)授業の評価ロジック ---
  let isUnstableSlot = (state.unstableBlocks && state.unstableBlocks[`${d}-${p}`]);
  if (lesson.isFraction) {
    if (isUnstableSlot) penalty -= 10000; // 端数授業は不安定枠を猛烈に優先
    else penalty += 500; // 不安定枠以外(AB交互枠になる場所)は少しペナルティ
  } else {
    if (isUnstableSlot) penalty += 5000; // 通常の授業は不安定枠を全力で回避
  }
  
  if (!isHigh('amPrioritySubjects') && isTargetRule(rules.amPrioritySubjects, lesson)) {
    if (p > 4) penalty += 300; 
  }
  
  if (!isHigh('lastPeriodSubjects') && isTargetRule(rules.lastPeriodSubjects, lesson)) {
    const grade = lesson.targets[0].split('-')[0];
    const maxP = state.periods[grade]?.[d] || Math.max(...PERIODS);
    if (p + (lesson.length||1) - 1 !== maxP) penalty += 200; 
  }

  if (!isHigh('limitOneSubjectPerDayStrict', true)) {
    const maxPeriod = Math.max(...PERIODS);
    for(let i=1; i<=maxPeriod; i++) {
      if (i >= p && i < p + (lesson.length||1)) continue; 
      if (schedule[d][i] && schedule[d][i].some(l => l.id !== lesson.id && l.subject === lesson.subject && l.targets.some(t => lesson.targets.includes(t)))) {
        penalty += 800; 
      }
    }
  }

  return penalty;
}