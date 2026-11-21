const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveObjectURL } = require('node:buffer');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { RuntimeLoader } = require('../extension/vendor/rive/rive.js');

const extension = join(__dirname, '../extension');

test('the exported pet interpolates between poses on the same skeleton', async () => {
  const wasm = readFileSync(join(extension, 'vendor/rive/rive.wasm'));
  RuntimeLoader.setWasmBinary(Uint8Array.from(wasm).buffer);
  const runtime = await RuntimeLoader.awaitInstance();
  // The headless motion test needs texture dimensions, but never draws pixels.
  const previousImage = globalThis.Image;
  globalThis.Image = class {
    set src(url) {
      resolveObjectURL(url).arrayBuffer().then((buffer) => {
        const png = new DataView(buffer);
        this.width = png.getUint32(16);
        this.height = png.getUint32(20);
        this.onload();
      });
    }
  };
  let file;
  try {
    file = await runtime.load(readFileSync(join(extension, 'voki.riv')), undefined, false);
  } finally {
    globalThis.Image = previousImage;
  }
  const board = file.artboardByName('Voki');
  const viewModel = file.defaultArtboardViewModel(board).defaultInstance();
  const machine = new runtime.StateMachineInstance(board.stateMachineByName('Voki poses'), board);
  machine.bindViewModelInstance(viewModel);
  const pose = viewModel.number('pose');
  const head = board.rootBone('Neck and helmet');
  const writingHand = board.rootBone('Writing hand');
  const advance = frames => {
    for (let frame = 0; frame < frames; frame++) {
      machine.advance(1 / 60);
      board.advance(1 / 60);
    }
  };
  try {
    pose.value = 2;
    advance(30);
    assert.ok(Math.abs(head.rotation - (-.13)) < .001);
    pose.value = 3;
    advance(6);
    assert.ok(head.rotation > -.13 && head.rotation < .05);
    advance(24);
    assert.ok(Math.abs(head.rotation - .05) < .001);
    const positions = [writingHand.x];
    for (let step = 0; step < 6; step++) {
      advance(5);
      positions.push(writingHand.x);
    }
    assert.ok(Math.max(...positions) - Math.min(...positions) > 2);
    pose.value = 4;
    advance(30);
    assert.ok(head.y < 118);
    assert.ok(Math.abs(head.rotation - (-.16)) < .001);
    pose.value = 5;
    advance(30);
    assert.ok(Math.abs(head.rotation - (-.08)) < .001);
  } finally {
    machine.delete();
    viewModel.unref();
    board.delete();
    file.unref();
  }
});
