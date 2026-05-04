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
        state.subjects.forEach(sub => {
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
    let placed = false, candidates = []; DAYS.forEach(d => PERIODS.forEach(p => candidates.push({d, p}))); candidates.sort(() => Math.random() - 0.5);
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