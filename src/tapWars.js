import { HttpError } from './httpSecurity.js';
import { activeLifecycle } from './kegLifecycle.js';
import { getMysteryConfig, isMysteryActive } from './mysteryTap.js';

function getTapDisplaySnapshot(db, tapId) {
  const tap = db
    .prepare(
      `SELECT tap_id, batch_id, graphic, override_enabled, override_name, override_style, override_abv, override_srm
       FROM taps WHERE tap_id = ?`
    )
    .get(tapId);
  if (!tap) throw new HttpError(400, `Tap ${tapId} does not exist`);

  let name = 'Tap ' + tapId;
  let style = '';
  let abv = null;
  let srm = null;
  let imageUrl = null;

  if (tap.override_enabled && tap.override_name) {
    name = tap.override_name;
    style = tap.override_style || '';
    abv = tap.override_abv;
    srm = tap.override_srm;
  } else if (tap.batch_id?.startsWith('custom:')) {
    const custom = db.prepare('SELECT name, style, abv, srm FROM custom_beverage WHERE id = ?').get(tap.batch_id);
    if (custom) {
      name = custom.name;
      style = custom.style || '';
      abv = custom.abv;
      srm = custom.srm;
    }
  } else if (tap.batch_id) {
    const batch = db
      .prepare('SELECT recipe_name, style, abv, srm, image_url FROM batches WHERE batch_id = ?')
      .get(tap.batch_id);
    if (batch) {
      name = batch.recipe_name || name;
      style = batch.style || '';
      abv = batch.abv;
      srm = batch.srm;
      imageUrl = batch.image_url || null;
    }
  }

  return {
    tap_id: tap.tap_id,
    batch_id: tap.batch_id,
    display_name: name,
    display_style: style,
    abv: abv !== undefined ? abv : null,
    srm: srm !== undefined ? srm : null,
    graphic: tap.graphic || 'pint_glass',
    image_url: imageUrl
  };
}

export function createBattleDraft(db, payload) {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'Invalid battle payload');
  const title = payload.title || 'Tap Wars';
  const copy = payload.description_copy ?? payload.copy ?? '';
  const theme = payload.theme || 'standard';
  const tapIdA = Number(payload.contestant_a_tap_id ?? payload.tapIdA);
  const tapIdB = Number(payload.contestant_b_tap_id ?? payload.tapIdB);

  if (!tapIdA || !tapIdB || tapIdA === tapIdB)
    throw new HttpError(400, 'Battle contestants must be two different taps');
  if (![1, 2, 3, 4, 5, 6].includes(tapIdA) || ![1, 2, 3, 4, 5, 6].includes(tapIdB)) {
    throw new HttpError(400, 'Contestant tap IDs must be valid tap numbers (1-6)');
  }

  const lifecycleA = activeLifecycle(db, tapIdA);
  const lifecycleB = activeLifecycle(db, tapIdB);

  if (!lifecycleA) throw new HttpError(400, `Tap ${tapIdA} does not have an active assigned keg`);
  if (!lifecycleB) throw new HttpError(400, `Tap ${tapIdB} does not have an active assigned keg`);

  const snapshotA = getTapDisplaySnapshot(db, tapIdA);
  const snapshotB = getTapDisplaySnapshot(db, tapIdB);

  const cleanTitle = (title || 'Tap Wars').trim().slice(0, 160);
  const cleanCopy = (copy || '').trim().slice(0, 500);
  const cleanTheme = ['classic', 'clash', 'neon', 'vintage'].includes(theme) ? theme : 'classic';

  return db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO tap_wars (title, copy, theme, state)
         VALUES (?, ?, ?, 'draft')`
      )
      .run(cleanTitle, cleanCopy, cleanTheme);

    const battleId = result.lastInsertRowid;

    db.prepare(
      `INSERT INTO tap_war_contestants
       (battle_id, contestant_side, tap_id, lifecycle_id, batch_id, display_name, display_style, abv, srm, graphic, image_url, vote_count)
       VALUES (?, 'a', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      battleId,
      tapIdA,
      lifecycleA.lifecycle_id,
      snapshotA.batch_id,
      snapshotA.display_name,
      snapshotA.display_style,
      snapshotA.abv,
      snapshotA.srm,
      snapshotA.graphic,
      snapshotA.image_url
    );

    db.prepare(
      `INSERT INTO tap_war_contestants
       (battle_id, contestant_side, tap_id, lifecycle_id, batch_id, display_name, display_style, abv, srm, graphic, image_url, vote_count)
       VALUES (?, 'b', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      battleId,
      tapIdB,
      lifecycleB.lifecycle_id,
      snapshotB.batch_id,
      snapshotB.display_name,
      snapshotB.display_style,
      snapshotB.abv,
      snapshotB.srm,
      snapshotB.graphic,
      snapshotB.image_url
    );

    return getBattleDetails(db, battleId, { isAdmin: true });
  })();
}

function parseBattleId(arg) {
  if (arg !== null && typeof arg === 'object') {
    return arg.battleId ?? arg.battle_id ?? arg.id;
  }
  return arg;
}

export function startBattle(db, battleIdArg, { now = new Date(), onStarted } = {}) {
  const battleId = parseBattleId(battleIdArg);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return db.transaction(() => {
    const battle = db.prepare('SELECT battle_id, state FROM tap_wars WHERE battle_id = ?').get(battleId);
    if (!battle) throw new HttpError(404, 'Battle not found');
    if (battle.state !== 'draft') throw new HttpError(409, `Battle cannot be started from state: ${battle.state}`);

    const existingActive = db.prepare("SELECT battle_id FROM tap_wars WHERE state = 'active'").get();
    if (existingActive) {
      throw new HttpError(409, 'Another Tap War is already active');
    }

    const contestants = db
      .prepare('SELECT contestant_side, tap_id, lifecycle_id FROM tap_war_contestants WHERE battle_id = ?')
      .all(battleId);

    if (contestants.length !== 2) throw new HttpError(409, 'Battle does not have valid contestant snapshot records');

    for (const contestant of contestants) {
      const active = activeLifecycle(db, contestant.tap_id);
      if (!active || active.lifecycle_id !== contestant.lifecycle_id) {
        throw new HttpError(409, `Tap ${contestant.tap_id} assignment has changed since battle draft creation`);
      }
    }

    db.prepare("UPDATE tap_wars SET state = 'active', started_at = ? WHERE battle_id = ?").run(timestamp, battleId);

    const started = getBattleDetails(db, battleId, { isAdmin: true });
    if (onStarted) {
      onStarted({
        battleId,
        title: started.title,
        contestantATapId: started.contestants.a.tap_id,
        contestantBTapId: started.contestants.b.tap_id,
        battle: started
      });
    }
    return started;
  })();
}

export function recordVote(db, payload) {
  const battleId = parseBattleId(payload);
  const contestantSide = String(payload.contestantSide ?? payload.contestant_side ?? '').toLowerCase();
  if (!['a', 'b'].includes(contestantSide)) throw new HttpError(400, 'Invalid contestant side');

  return db.transaction(() => {
    const battle = db.prepare('SELECT battle_id, state FROM tap_wars WHERE battle_id = ?').get(battleId);
    if (!battle) throw new HttpError(404, 'Battle not found');
    if (battle.state !== 'active') {
      throw new HttpError(409, 'Voting has ended for this battle');
    }

    const contestant = db
      .prepare('SELECT tap_id, lifecycle_id FROM tap_war_contestants WHERE battle_id = ? AND contestant_side = ?')
      .get(battleId, contestantSide);
    if (!contestant) throw new HttpError(404, 'Contestant not found');

    const currentLifecycle = activeLifecycle(db, contestant.tap_id);
    if (!currentLifecycle || currentLifecycle.lifecycle_id !== contestant.lifecycle_id) {
      endBattle(db, battleId, { reason: 'tap_reassigned' });
      throw new HttpError(409, 'Voting closed: contestant tap assignment has changed');
    }

    db.prepare(
      `UPDATE tap_war_contestants
       SET vote_count = vote_count + 1
       WHERE battle_id = ? AND contestant_side = ?`
    ).run(battleId, contestantSide);

    const updatedContestants = db
      .prepare('SELECT contestant_side, vote_count FROM tap_war_contestants WHERE battle_id = ?')
      .all(battleId);

    const voteCountA = updatedContestants.find((c) => c.contestant_side === 'a')?.vote_count || 0;
    const voteCountB = updatedContestants.find((c) => c.contestant_side === 'b')?.vote_count || 0;

    return {
      success: true,
      battle_id: battleId,
      battleId,
      contestant_side: contestantSide.toUpperCase(),
      contestantSide: contestantSide.toUpperCase(),
      contestantAVoteCount: voteCountA,
      contestantBVoteCount: voteCountB,
      contestant_a_vote_count: voteCountA,
      contestant_b_vote_count: voteCountB
    };
  })();
}

export function endBattle(db, battleIdArg, { reason = 'admin_ended', now = new Date(), onEnded } = {}) {
  const battleId = parseBattleId(battleIdArg);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return db.transaction(() => {
    const battle = db.prepare('SELECT battle_id, state FROM tap_wars WHERE battle_id = ?').get(battleId);
    if (!battle) throw new HttpError(404, 'Battle not found');
    if (battle.state !== 'active') {
      return getBattleDetails(db, battleId, { isAdmin: true });
    }

    db.prepare(
      `UPDATE tap_wars
       SET state = 'ended', end_reason = ?, ended_at = ?
       WHERE battle_id = ?`
    ).run(reason, timestamp, battleId);

    const ended = getBattleDetails(db, battleId, { isAdmin: true });
    if (onEnded) {
      onEnded({ battleId, reason, battle: ended });
    }
    return ended;
  })();
}

export function revealBattle(db, battleIdArg, { now = new Date() } = {}) {
  const battleId = parseBattleId(battleIdArg);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return db.transaction(() => {
    const battle = db.prepare('SELECT battle_id, state FROM tap_wars WHERE battle_id = ?').get(battleId);
    if (!battle) throw new HttpError(404, 'Battle not found');
    if (battle.state !== 'ended') {
      if (battle.state === 'revealed') return getBattleDetails(db, battleId, { isAdmin: true });
      throw new HttpError(409, 'Battle must be ended before results can be revealed');
    }

    db.prepare(
      `UPDATE tap_wars
       SET state = 'revealed', revealed_at = ?
       WHERE battle_id = ?`
    ).run(timestamp, battleId);

    return getBattleDetails(db, battleId, { isAdmin: true });
  })();
}

export function checkActiveBattleLifecycleInvalidation(db, { tapId, lifecycleId, reason = 'tap_reassigned', onEnded }) {
  const activeBattle = db
    .prepare(
      `SELECT w.battle_id FROM tap_wars w
       JOIN tap_war_contestants c ON c.battle_id = w.battle_id
       WHERE w.state = 'active' AND (c.tap_id = ? OR c.lifecycle_id = ?)`
    )
    .get(tapId, lifecycleId);

  if (activeBattle) {
    const validReason = ['admin_ended', 'tap_reassigned', 'keg_ended'].includes(reason)
      ? reason
      : reason === 'reassigned'
        ? 'tap_reassigned'
        : 'keg_ended';
    endBattle(db, activeBattle.battle_id, { reason: validReason, onEnded });
  }
}

export function getBattleDetails(db, battleId, { isAdmin = false } = {}) {
  const battle = db
    .prepare(
      `SELECT battle_id, title, copy, theme, state, end_reason, created_at, started_at, ended_at, revealed_at
       FROM tap_wars WHERE battle_id = ?`
    )
    .get(battleId);
  if (!battle) return null;

  const contestantsRows = db
    .prepare(
      `SELECT battle_id, contestant_side, tap_id, lifecycle_id, batch_id, display_name, display_style, abv, srm, graphic, image_url, vote_count
       FROM tap_war_contestants WHERE battle_id = ?`
    )
    .all(battleId);

  const contestants = {};
  let totalVotes = 0;

  for (const row of contestantsRows) {
    const mysteryState = getMysteryConfig(db, row.lifecycle_id);
    const activeMystery = isMysteryActive(mysteryState);

    let displayName = row.display_name;
    let displayStyle = row.display_style;
    let imageUrl = row.image_url;

    if (!isAdmin && activeMystery) {
      const redactedSet = new Set(mysteryState.redactedCategories);
      if (redactedSet.has('name')) displayName = 'Mystery Tap';
      if (redactedSet.has('style')) displayStyle = '';
      if (redactedSet.has('image')) imageUrl = null;
    }

    const sideLower = row.contestant_side.toLowerCase();
    const sideUpper = row.contestant_side.toUpperCase();
    const cObj = {
      tap_id: row.tap_id,
      tapId: row.tap_id,
      lifecycle_id: row.lifecycle_id,
      lifecycleId: row.lifecycle_id,
      batch_id: row.batch_id,
      batchId: row.batch_id,
      display_name: displayName,
      displayName: displayName,
      beerName: displayName,
      display_style: displayStyle,
      displayStyle: displayStyle,
      style: displayStyle,
      abv: row.abv,
      srm: row.srm,
      graphic: row.graphic,
      image_url: imageUrl,
      imageUrl,
      is_mystery: activeMystery,
      isMystery: activeMystery,
      vote_count: isAdmin || battle.state === 'revealed' ? row.vote_count : null,
      voteCount: isAdmin || battle.state === 'revealed' ? row.vote_count : null
    };
    contestants[sideLower] = cObj;
    contestants[sideUpper] = cObj;

    totalVotes += row.vote_count;
  }

  const showResults = isAdmin || battle.state === 'revealed';
  let winner = null;
  let percentA;
  let percentB;

  if (showResults && contestants.a && contestants.b) {
    const votesA = contestantsRows.find((r) => r.contestant_side === 'a')?.vote_count || 0;
    const votesB = contestantsRows.find((r) => r.contestant_side === 'b')?.vote_count || 0;

    if (votesA > votesB) winner = 'a';
    else if (votesB > votesA) winner = 'b';
    else winner = 'tie';

    if (totalVotes > 0) {
      percentA = Math.round((votesA / totalVotes) * 1000) / 10;
      percentB = Math.round((votesB / totalVotes) * 1000) / 10;
    } else {
      percentA = 0;
      percentB = 0;
    }

    contestants.a.vote_count = votesA;
    contestants.a.voteCount = votesA;
    contestants.a.percent = percentA;
    contestants.b.vote_count = votesB;
    contestants.b.voteCount = votesB;
    contestants.b.percent = percentB;
  }

  return {
    battle_id: battle.battle_id,
    battleId: battle.battle_id,
    title: battle.title,
    copy: battle.copy,
    descriptionCopy: battle.copy,
    description_copy: battle.copy,
    theme: battle.theme,
    state: battle.state,
    end_reason: battle.end_reason,
    endReason: battle.end_reason,
    created_at: battle.created_at,
    createdAt: battle.created_at,
    started_at: battle.started_at,
    startedAt: battle.started_at,
    ended_at: battle.ended_at,
    endedAt: battle.ended_at,
    revealed_at: battle.revealed_at,
    revealedAt: battle.revealed_at,
    contestantATapId: contestants.a?.tap_id,
    contestantBTapId: contestants.b?.tap_id,
    contestant_a_tap_id: contestants.a?.tap_id,
    contestant_b_tap_id: contestants.b?.tap_id,
    contestant_a_votes: contestants.a?.vote_count,
    contestant_b_votes: contestants.b?.vote_count,
    contestantAVotes: contestants.a?.vote_count,
    contestantBVotes: contestants.b?.vote_count,
    contestantA: contestants.a,
    contestantB: contestants.b,
    contestants,
    total_votes: showResults ? totalVotes : null,
    totalVotes: showResults ? totalVotes : null,
    winner: showResults ? winner : null,
    winnerSide: showResults && winner && winner !== 'tie' ? winner.toUpperCase() : null,
    results_pending: !showResults
  };
}

export function getActiveBattle(db, { isAdmin = false } = {}) {
  const active = db
    .prepare(
      `SELECT battle_id FROM tap_wars
       WHERE state IN ('active', 'draft', 'ended')
       ORDER BY
         CASE state
           WHEN 'active' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'ended' THEN 3
           ELSE 4
         END,
         battle_id DESC
       LIMIT 1`
    )
    .get();
  if (!active) return null;
  return getBattleDetails(db, active.battle_id, { isAdmin });
}

export function getBattleHistory(db, { isAdmin = false, limit = 20 } = {}) {
  const rows = db
    .prepare("SELECT battle_id FROM tap_wars WHERE state IN ('ended', 'revealed') ORDER BY battle_id DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => getBattleDetails(db, r.battle_id, { isAdmin }));
}
