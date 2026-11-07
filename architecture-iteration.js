// Architecture iteration package entry. Project link or canonical repository root only.
return defineWorkflow((workflow) => {
  const packageBinding = "architecture-iteration/project-link-v1";
  let companion = null;
  const packetLimit = 45 * 1024;
  const entryReadonly = workflow.state().readonly;
  let latest = null;
  let attempt = null;
  let phase = 'resolve';
  let outcome = null;

  // These helpers are pure. All host effects remain direct synchronous statements.
  const bytes = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let count = 0;
    for (const character of text) {
      const point = character.codePointAt(0);
      count += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
    return count;
  };
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const command = (operation, packet) => {
    if (!companion) throw new Error('Artifact companion has not passed preflight.');
    const input = JSON.stringify(packet);
    if (bytes(input) >= packetLimit) throw new Error('Artifact control request exceeds the 45 KiB shell transport envelope; domain data must use chunked input/output transport.');
    // Single-quoted printf data cannot expand variables, execute substitutions, or
    // terminate a heredoc. Use PATH's node, not the host's process.execPath.
    return "printf '%s' " + quote(input) + ' | node -- ' + quote(companion) + ' ' + quote(operation);
  };
  const reply = (result) => {
    if (!result || result.killed || result.truncated || typeof result.output !== 'string' || bytes(result.output) >= packetLimit) {
      throw new Error('Artifact shell reply was killed, truncated, missing, or oversized.');
    }
    let packet;
    try { packet = JSON.parse(result.output); } catch { throw new Error('Artifact shell did not return one JSON packet.'); }
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Artifact shell packet must be an object.');
    if (!result.ok || result.exitCode !== 0 || packet.ok !== true) {
      const diagnostic = packet.error?.message || result.output || 'Artifact shell failed.';
      const error = new Error(diagnostic);
      if (phase === 'prepare' && /^(E_INPUT|E_CONFIG|E_SIZE)$/.test(packet.error?.code || '')) error.reason = 'needs-input';
      if (phase === 'prepare' && packet.error?.latest) latest = reference(packet.error.latest);
      throw error;
    }
    if (!packet.data || typeof packet.data !== 'object' || Array.isArray(packet.data) || Object.keys(packet).length !== 2) {
      throw new Error('Artifact shell success packet must contain only ok and an object data value.');
    }
    return packet.data;
  };
  const reference = (value) => {
    if (!value || typeof value.path !== 'string' || !value.path || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(value.round) || value.round < 0) {
      throw new Error('Artifact shell returned an invalid snapshot reference.');
    }
    return value;
  };
  const inputReference = (value) => {
    if (!value || typeof value.path !== 'string' || !value.path || !/^[a-f0-9]{64}$/.test(value.sha256 || '') ||
        !Number.isSafeInteger(value.length) || value.length < 1 || Object.keys(value).length !== 3) {
      throw new Error('Artifact shell returned an invalid input projection descriptor.');
    }
    return value;
  };
  const roleReference = (value) => {
    if (!value || typeof value.path !== 'string' || !value.path || !/^[a-f0-9]{64}$/.test(value.sha256 || '') ||
        !Number.isSafeInteger(value.length) || value.length < 1 || Object.keys(value).length !== 3) {
      throw new Error('Artifact shell returned an invalid staged-role descriptor.');
    }
    return value;
  };
  const projection = (value, expectedRound) => {
    if (!value || value.schema_version !== 1 || value.round !== expectedRound || typeof value.source?.text !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.source?.sha256 || '') || !Array.isArray(value.human_answers) ||
        !value.artifacts || typeof value.artifacts !== 'object' || typeof value.rationale !== 'string' ||
        !['continue', 'needs-human', 'candidate'].includes(value.disposition)) {
      throw new Error('Artifact shell returned an invalid snapshot projection.');
    }
    return value;
  };
  const staged = (result, round, slot) => {
    const data = reply(result);
    if (data.round !== round || data.slot !== slot) throw new Error('Artifact shell returned the wrong role acknowledgement.');
  };
  const structured = (result) => {
    if (!result || !result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
      throw new Error('Role did not return native structured result.output.');
    }
    return result.output;
  };
  const uploadReference = (value, expectedAttempt, slot, length) => {
    if (!value || value.attempt !== expectedAttempt || value.slot !== slot || value.length !== length ||
        typeof value.path !== 'string' || value.path.slice(0, expectedAttempt.length) !== expectedAttempt ||
        !/^[\\/]\.output-[0-9a-f-]{36}$/.test(value.path.slice(expectedAttempt.length)) || Object.keys(value).length !== 4) {
      throw new Error('Artifact shell returned an invalid output upload binding.');
    }
    return { path: value.path, length, tail: null };
  };
  const uploaded = (value, upload, offset, text) => {
    if (value.upload !== upload.path || value.offset !== offset || value.next !== offset + text.length ||
        value.length !== upload.length || value.text !== text || JSON.stringify(value.previous) !== JSON.stringify(upload.tail) ||
        !/^[a-f0-9]{64}$/.test(value.sha256 || '') || Object.keys(value).length !== 7) {
      throw new Error('Artifact shell returned an incomplete or inconsistent output packet.');
    }
    upload.tail = { offset, sha256: value.sha256 };
  };

  let configPath = String(load('args') || '').trim();
  if ((configPath.startsWith('"') && configPath.endsWith('"')) || (configPath.startsWith("'") && configPath.endsWith("'"))) {
    configPath = configPath.slice(1, -1);
  }
  if (!configPath || /[\0\r\n]/.test(configPath)) {
    return workflow.exit({ reason: 'needs-input', diagnostic: 'Supply one JSON configuration file path (optionally quoted).', latest_snapshot: null, round: null });
  }

  try {
    // The host seeds only args/intent, not the executing workflow's filename.
    // Support the installer's fixed project symlink and direct repository-root
    // invocation only. No global roots, ancestor search, or arbitrary-path launch.
    // A present but invalid project link MUST NOT fall back to another package.
    const resolver = [
      "const fs = require('node:fs'), path = require('node:path');",
      'const binding = process.argv[1];',
      "const installed = path.resolve('.pi/workflows/architecture-iteration.js');",
      "const probe = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };",
      "const localCandidates = [path.resolve('workflows/architecture-iteration/architecture-iteration.js'), path.resolve('architecture-iteration.js')];",
      "const local = localCandidates.find(p => probe(p)) || null;",
      'try {',
      '  const link = probe(installed);',
      '  if (!link && !local) throw new Error(\"No canonical workflow found at the repository root; run install.mjs from the project root.\");',
      '  const source = link ? (link.isSymbolicLink() ? fs.realpathSync(installed) : installed) : local;',
      "  if (path.basename(fs.realpathSync(source)) !== 'architecture-iteration.js') throw new Error('Installed workflow does not target the canonical architecture workflow filename.');",
      '  if (link && local) {',
      '    if (link.isSymbolicLink()) {',
      "      if (fs.realpathSync(local) !== source) throw new Error('Installed workflow conflicts with the repository workflow; refuse an ambiguous companion.');",
      '    } else {',
      "      if (!fs.readFileSync(source).equals(fs.readFileSync(local))) throw new Error('Installed workflow copy conflicts with the repository workflow; rerun install.mjs to refresh it.');",
      '    }',
      '  }',
      '  const stat = fs.statSync(source);',
      "  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Canonical architecture workflow is not a bounded regular file.');",
      "  const text = fs.readFileSync(source, 'utf8');",
      "  if (!text.startsWith('// Architecture iteration package entry. Project link or canonical repository root only.\\n') || !text.includes('const packageBinding = ' + JSON.stringify(binding) + ';')) throw new Error('Installed workflow does not target this architecture workflow package.');",
      "  const companion = path.join(path.dirname(source), 'artifacts.mjs');",
      '  const helper = fs.lstatSync(companion);',
      "  if (!helper.isFile() || fs.realpathSync(companion) !== companion) throw new Error('Artifact companion must be a regular file beside the canonical workflow.');",
      '  process.stdout.write(JSON.stringify({ok:true,data:{binding,source,companion}}));',
      '} catch (error) {',
      "  process.stdout.write(JSON.stringify({ok:false,error:{message:'Architecture package preflight failed: ' + error.message + ' Run install.mjs from the project root.'}}));",
      '  process.exitCode = 1;',
      '}',
    ].join('\n');
    // This effect reads only the fixed workflow paths and canonical sibling. Its
    // transport must settle successfully BEFORE prepare can create any evidence.
    // Writes are restricted to later mechanical shell calls. No model turn runs
    // while readonly is off. Fresh sessions/readonly are NOT a security sandbox.
    workflow.readonly(false);
    const resolvedShell = workflow.shell('node -e ' + quote(resolver) + ' -- ' + quote(packageBinding), { timeout: 30 });
    const resolved = reply(resolvedShell);
    if (Object.keys(resolved).length !== 3 || resolved.binding !== packageBinding ||
        typeof resolved.source !== 'string' || typeof resolved.companion !== 'string' ||
        !/^(?:\/|[A-Za-z]:[\\/])/.test(resolved.source) || /[\0\r\n]/.test(resolved.source) ||
        !/[\\/]architecture-iteration\.js$/.test(resolved.source) ||
        resolved.companion !== resolved.source.replace(/architecture-iteration\.js$/, 'artifacts.mjs')) {
      throw new Error('Architecture package preflight returned an invalid canonical companion binding.');
    }
    companion = resolved.companion;
    phase = 'prepare';
    const preparedShell = workflow.shell(command('prepare', { config_path: configPath }), { timeout: 30 });
    const prepared = reply(preparedShell);
    latest = reference(prepared.latest);
    let inputRef = inputReference(prepared.input_ref);
    if (!Number.isInteger(prepared.max_rounds) || prepared.max_rounds < 1 || prepared.max_rounds > 8) throw new Error('Artifact shell returned an invalid round cap.');
    let configAttempt = prepared.attempt ?? null;
    let configRedo = Array.isArray(prepared.redo) ? prepared.redo : [];
    const schemaShell = workflow.shell(command('schemas', {}), { timeout: 30 });
    const schemas = reply(schemaShell);
    if (schemas.agenda?.type !== 'object' || schemas.participant?.type !== 'object' || schemas.expert?.type !== 'object' || schemas.synthesis?.type !== 'object') {
      throw new Error('Artifact shell returned invalid role schemas.');
    }
    // Stable voice units own their skill route and output contract, not a private
    // transcript. Continuity comes only from the explicit packets below. Do not
    // use notebookWrite: its host-buffered previews can survive workflow.new().
    const master = { prompt: '/skill:architecture-iteration-master', agenda: schemas.agenda, synthesis: schemas.synthesis };
    const expertVoice = { prompt: '/skill:architecture-iteration-expert', schema: schemas.expert };
    const participants = [];
    for (const voice of ['journey', 'model', 'stressor']) {
      participants.push({ voice, prompt: '/skill:architecture-iteration-' + voice,
        // Constrain native submission before it settles. Keep the deterministic
        // identity check too: an unexpected result must never be relabelled.
        schema: { ...schemas.participant, properties: { ...schemas.participant.properties,
          voice: { ...schemas.participant.properties.voice, enum: [voice] } } },
      });
    }
    workflow.readonly(entryReadonly);
    workflow.checkpoint({ phase: 'prepared', latest_snapshot: latest.path, round: latest.round });

    for (let iteration = 0; iteration < prepared.max_rounds; iteration++) {
      phase = 'input';
      workflow.readonly(false);
      // Packet count follows the exact input length, not an arbitrary input cap.
      // Host runtime/context budgets still bound work. Never use a partial input.
      const parts = [];
      let offset = 0;
      while (offset < inputRef.length) {
        const inputShell = workflow.shell(command('input', { input_ref: inputRef, offset }), { timeout: 30 });
        const part = reply(inputShell);
        if (part.offset !== offset || part.length !== inputRef.length || part.sha256 !== inputRef.sha256 ||
            typeof part.text !== 'string' || part.text.length < 1 || part.text.length > 4000 ||
            part.next !== offset + part.text.length || part.next > inputRef.length) {
          throw new Error('Artifact shell returned an incomplete or inconsistent input packet.');
        }
        parts.push(part.text);
        offset = part.next;
      }
      let decoded;
      try { decoded = JSON.parse(parts.join('')); } catch { throw new Error('Complete input projection is not valid JSON or exceeds host memory/string limits; no partial input was used.'); }
      const snapshot = projection(decoded, latest.round);

      // Resume an in-progress round by attempt token, or begin a fresh one. A
      // resumed attempt reuses its staged roles and only runs the missing/stale
      // remainder; redo invalidates the named slot and all dependents.
      let round;
      let slotsState = new Map();
      if (configAttempt) {
        phase = 'attempt-status';
        const statusShell = workflow.shell(command('attempt-status', { attempt: configAttempt }), { timeout: 30 });
        const status = reply(statusShell);
        if (status.round !== latest.round + 1 || status.base?.path !== latest.path || status.base?.sha256 !== latest.sha256) {
          throw new Error('Artifact shell returned an attempt that does not continue the latest committed snapshot.');
        }
        attempt = status.attempt;
        round = status.round;
        for (const row of status.slots) slotsState.set(row.slot, row.state);
        if (configRedo.length) {
          phase = 'invalidate-roles';
          const invalidateShell = workflow.shell(command('invalidate-roles', { attempt, slots: configRedo }), { timeout: 30 });
          const invalidated = reply(invalidateShell);
          slotsState = new Map(invalidated.slots.map((row) => [row.slot, row.state]));
        }
      } else {
        phase = 'begin';
        const beginShell = workflow.shell(command('begin', { latest, input_ref: inputRef }), { timeout: 30 });
        const begun = reply(beginShell);
        if (typeof begun.attempt !== 'string' || !begun.attempt || begun.round !== latest.round + 1 || typeof begun.next_snapshot !== 'string') {
          throw new Error('Artifact shell returned an invalid round attempt.');
        }
        attempt = begun.attempt;
        round = begun.round;
      }
      workflow.checkpoint({ phase: 'round-begin', attempt, round: latest.round, latest_snapshot: latest.path });

      // Turn table: slot order is fixed; voice/prompt/schema/input derive per turn.
      // Inputs are read lazily from staged outputs so a resumed round rebuilds
      // packets exactly as the canonical order would.
      const proposalsFor = () => ['journey', 'model', 'stressor'].map((voice) => outputs.get('explore-' + voice));
      const challengesFor = () => ['journey', 'model', 'stressor'].map((voice) => outputs.get('challenge-' + voice));
      const turns = [
        { slot: 'agenda', prompt: master.prompt, args: 'agenda', schema: master.agenda, input: () => ({ round, phase: 'agenda', snapshot }) },
        { slot: 'explore-journey', prompt: participants[0].prompt, args: 'explore', schema: participants[0].schema, voice: 'journey', input: () => ({ round, phase: 'explore', snapshot, agenda: outputs.get('agenda') }) },
        { slot: 'explore-model', prompt: participants[1].prompt, args: 'explore', schema: participants[1].schema, voice: 'model', input: () => ({ round, phase: 'explore', snapshot, agenda: outputs.get('agenda') }) },
        { slot: 'explore-stressor', prompt: participants[2].prompt, args: 'explore', schema: participants[2].schema, voice: 'stressor', input: () => ({ round, phase: 'explore', snapshot, agenda: outputs.get('agenda') }) },
        { slot: 'expert', prompt: expertVoice.prompt, args: 'answer', schema: expertVoice.schema, input: () => ({ round, phase: 'answer', snapshot, agenda: outputs.get('agenda'), proposals: proposalsFor() }) },
        { slot: 'challenge-journey', prompt: participants[0].prompt, args: 'challenge', schema: participants[0].schema, voice: 'journey', input: () => ({ round, phase: 'challenge', snapshot, agenda: outputs.get('agenda'), proposals: proposalsFor(), expert: outputs.get('expert') }) },
        { slot: 'challenge-model', prompt: participants[1].prompt, args: 'challenge', schema: participants[1].schema, voice: 'model', input: () => ({ round, phase: 'challenge', snapshot, agenda: outputs.get('agenda'), proposals: proposalsFor(), expert: outputs.get('expert') }) },
        { slot: 'challenge-stressor', prompt: participants[2].prompt, args: 'challenge', schema: participants[2].schema, voice: 'stressor', input: () => ({ round, phase: 'challenge', snapshot, agenda: outputs.get('agenda'), proposals: proposalsFor(), expert: outputs.get('expert') }) },
        { slot: 'synthesis', prompt: master.prompt, args: 'synthesize', schema: master.synthesis, input: () => ({ round, phase: 'synthesize', snapshot, agenda: outputs.get('agenda'), proposals: proposalsFor(), expert: outputs.get('expert'), challenges: challengesFor() }) },
      ];

      const outputs = new Map();
      let synthesisRef = null; // fresh synthesis upload binding; resumed synthesis is read from staging
      for (const turn of turns) {
        const state = slotsState.get(turn.slot) ?? 'missing';
        if (state === 'staged') {
          phase = 'role-read-' + turn.slot;
          const roleShell = workflow.shell(command('role-read', { attempt, slot: turn.slot }), { timeout: 30 });
          const roleRef = roleReference(reply(roleShell));
          const parts = [];
          let roleOffset = 0;
          while (roleOffset < roleRef.length) {
            const chunkShell = workflow.shell(command('role-chunk', { role_ref: roleRef, offset: roleOffset }), { timeout: 30 });
            const part = reply(chunkShell);
            if (part.offset !== roleOffset || part.length !== roleRef.length || part.sha256 !== roleRef.sha256 ||
                typeof part.text !== 'string' || part.text.length < 1 || part.text.length > 4000 ||
                part.next !== roleOffset + part.text.length || part.next > roleRef.length) {
              throw new Error('Artifact shell returned an incomplete or inconsistent staged-role packet.');
            }
            parts.push(part.text);
            roleOffset = part.next;
          }
          let stagedRole;
          try { stagedRole = JSON.parse(parts.join('')); } catch { throw new Error('Staged role is not valid JSON; cannot resume the round.'); }
          if (!stagedRole || typeof stagedRole !== 'object' || Array.isArray(stagedRole)) {
            throw new Error('Staged role is not a native structured object; cannot resume the round.');
          }
          outputs.set(turn.slot, stagedRole);
          continue;
        }
        phase = 'reset-' + turn.slot;
        workflow.new();
        workflow.readonly(true);
        phase = turn.slot;
        const run = workflow.run(turn.prompt, {
          args: 'round-' + round + ' ' + turn.args, input: turn.input(),
          output: { schema: turn.schema },
        });
        const output = structured(run);
        if (turn.voice && output.voice !== turn.voice) throw new Error('Participant voice must equal ' + turn.voice + '.');
        workflow.readonly(false);
        const wire = JSON.stringify(output);
        const uploadShell = workflow.shell(command('output-begin', { attempt, slot: turn.slot, length: wire.length }), { timeout: 30 });
        const upload = uploadReference(reply(uploadShell), attempt, turn.slot, wire.length);
        for (let chunkOffset = 0; chunkOffset < wire.length; chunkOffset += 4000) {
          const text = wire.slice(chunkOffset, chunkOffset + 4000);
          const chunkShell = workflow.shell(command('output-chunk', { upload: upload.path, offset: chunkOffset, text, previous: upload.tail }), { timeout: 30 });
          uploaded(reply(chunkShell), upload, chunkOffset, text);
        }
        if (turn.slot === 'synthesis') {
          synthesisRef = upload; // finish consumes synthesis via output_ref; never staged
        } else {
          const stageShell = workflow.shell(command('stage', { attempt, slot: turn.slot, output_ref: upload }), { timeout: 30 });
          staged(stageShell, round, turn.slot);
        }
        workflow.readonly(true);
        outputs.set(turn.slot, output);
      }

      phase = 'commit';
      workflow.readonly(false);
      const synthesis = outputs.get('synthesis');
      const committedShell = workflow.shell(command('finish', {
        attempt,
        ...(synthesisRef ? { output_ref: synthesisRef } : { output: synthesis }),
      }), { timeout: 30 });
      const committed = reply(committedShell);
      const committedReference = reference(committed.latest);
      if (committedReference.round !== round ||
          !['continue', 'needs-human', 'candidate'].includes(committed.disposition) || Object.keys(committed).length !== 2) {
        throw new Error('Artifact shell returned an invalid committed-round packet.');
      }
      latest = committedReference;
      attempt = null;
      configAttempt = null;
      configRedo = [];
      workflow.readonly(entryReadonly);
      workflow.checkpoint({ phase: 'committed', latest_snapshot: latest.path, round: latest.round, disposition: committed.disposition });
      if (committed.disposition !== 'continue') {
        outcome = { reason: committed.disposition, diagnostic: 'Complete rationale is retained in the latest snapshot.' };
        break;
      }
      if (iteration + 1 < prepared.max_rounds) {
        phase = 'load';
        workflow.readonly(false);
        const loadedShell = workflow.shell(command('load', { latest }), { timeout: 30 });
        const loaded = reply(loadedShell);
        const loadedReference = reference(loaded.latest);
        if (loadedReference.path !== latest.path || loadedReference.sha256 !== latest.sha256 || loadedReference.round !== latest.round) {
          throw new Error('Artifact shell loaded a different snapshot reference.');
        }
        inputRef = inputReference(loaded.input_ref);
        workflow.readonly(entryReadonly);
      }
    }
    if (!outcome) outcome = { reason: 'round-limit', diagnostic: 'Invocation round cap reached; resume from the latest committed snapshot.' };
    if (attempt) outcome = { ...outcome, attempt };
  } catch (error) {
    // A commit may succeed just before transport fails. Recover a small validated
    // reference, never guess that a draft or a failed reply is a committed round.
    if (attempt && phase === 'commit') {
      try {
        workflow.readonly(false);
        const recoveryShell = workflow.shell(command('recover', { attempt }), { timeout: 30 });
        const recovered = reply(recoveryShell);
        latest = reference(recovered.latest);
      } catch { /* Preserve the last confirmed reference and original diagnostic. */ }
    }
    if (!latest && phase === 'prepare' && error?.reason !== 'needs-input') {
      try {
        workflow.readonly(false);
        const inspectShell = workflow.shell(command('inspect', { config_path: configPath }), { timeout: 30 });
        const inspected = reply(inspectShell);
        if (inspected.latest) latest = reference(inspected.latest);
      } catch { /* Preparation may have failed before creating any snapshot. */ }
    }
    outcome = { reason: error?.reason === 'needs-input' ? 'needs-input' : 'failed', diagnostic: String(error?.message || error).slice(0, 4096), phase };
    if (attempt) outcome = { ...outcome, attempt };
  } finally {
    // Cancellation can terminate the VM before finally executes. See README.
    workflow.readonly(entryReadonly);
  }
  return workflow.exit({ ...outcome, latest_snapshot: latest ? latest.path : null, round: latest ? latest.round : null });
});
