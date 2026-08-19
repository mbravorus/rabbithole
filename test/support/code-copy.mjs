import assert from "node:assert/strict";

export async function assertCodeCopy(page, { scope, rawCode, hover = true, click = false, label }) {
  const code = page.locator(`${scope} pre code`);
  await code.first().waitFor();
  const blocks = page.locator(`${scope} .code-block`);
  const preCount = await code.count();
  const blockCount = await blocks.count();
  const buttonCount = await page.locator(`${scope} .code-copy`).count();
  assert(preCount > 0, `${label}: fixture should contain a fenced code block`);
  assert.equal(blockCount, preCount, `${label}: every fenced code block should have one wrapper`);
  assert.equal(buttonCount, preCount, `${label}: every fenced code block should have one copy control`);

  const initial = await blocks.evaluateAll((elements) => elements.map((block) => {
    const buttons = block.querySelectorAll(":scope > .code-copy");
    const button = buttons[0];
    const copyIcon = button && button.querySelector(".ic-copy");
    const checkIcon = button && button.querySelector(".ic-check");
    const codeElement = block.querySelector("pre code");
    return {
      buttonCount: buttons.length,
      wrapperPosition: getComputedStyle(block).position,
      buttonPosition: button && getComputedStyle(button).position,
      top: button && getComputedStyle(button).top,
      right: button && getComputedStyle(button).right,
      buttonOpacity: button && getComputedStyle(button).opacity,
      copyHidden: copyIcon && copyIcon.hidden,
      copyDisplay: copyIcon && getComputedStyle(copyIcon).display,
      checkHidden: checkIcon && checkIcon.hidden,
      checkDisplay: checkIcon && getComputedStyle(checkIcon).display,
      rawCode: codeElement && codeElement.textContent.replace(/\n$/, ""),
    };
  }));

  for (const state of initial) {
    assert.equal(state.buttonCount, 1, `${label}: each wrapper should own one copy control`);
    assert.equal(state.wrapperPosition, "relative", `${label}: code wrapper should position the control`);
    assert.equal(state.buttonPosition, "absolute", `${label}: copy control should be absolutely positioned`);
    assert.equal(state.top, "7px", `${label}: copy control should sit 7px from the top`);
    assert.equal(state.right, "7px", `${label}: copy control should sit 7px from the right`);
    assert.equal(state.copyHidden, false, `${label}: copy icon should be active initially`);
    assert.notEqual(state.copyDisplay, "none", `${label}: copy icon should be visible initially`);
    assert.equal(state.checkHidden, true, `${label}: check icon should be natively hidden initially`);
    assert.equal(state.checkDisplay, "none", `${label}: check icon should be visually hidden initially`);
  }

  const targetIndex = initial.findIndex((state) => state.rawCode === rawCode);
  assert.notEqual(targetIndex, -1, `${label}: rendered code should preserve the exact raw source`);
  if (!hover) return;
  assert.equal(initial[targetIndex].buttonOpacity, "0", `${label}: copy control should be quiet before hover`);
  const targetBlock = blocks.nth(targetIndex);
  const targetButton = targetBlock.locator(":scope > .code-copy");
  await targetBlock.hover();
  const buttonHandle = await targetButton.elementHandle();
  assert(buttonHandle, `${label}: copy control should be attached`);
  await page.waitForFunction((button) => Number.parseFloat(getComputedStyle(button).opacity) >= 0.99, buttonHandle);

  if (!click) return;
  await targetButton.click();
  await page.waitForFunction((button) => button.getAttribute("aria-label") === "Copied", buttonHandle);
  await page.waitForFunction(async (expected) => {
    try {
      return await navigator.clipboard.readText() === expected;
    } catch {
      return false;
    }
  }, rawCode);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), rawCode, `${label}: copy should preserve exact raw code`);

  const copied = await targetButton.evaluate((button) => {
    const copyIcon = button.querySelector(".ic-copy");
    const checkIcon = button.querySelector(".ic-check");
    return {
      copied: button.classList.contains("copied"),
      label: button.getAttribute("aria-label"),
      copyHidden: copyIcon.hidden,
      copyDisplay: getComputedStyle(copyIcon).display,
      checkHidden: checkIcon.hidden,
      checkDisplay: getComputedStyle(checkIcon).display,
    };
  });
  assert.equal(copied.copied, true, `${label}: copied class should reflect success`);
  assert.equal(copied.label, "Copied", `${label}: accessible label should reflect success`);
  assert.equal(copied.copyHidden, true, `${label}: copy icon should be natively hidden after copying`);
  assert.equal(copied.copyDisplay, "none", `${label}: copy icon should be visually hidden after copying`);
  assert.equal(copied.checkHidden, false, `${label}: check icon should be active after copying`);
  assert.notEqual(copied.checkDisplay, "none", `${label}: check icon should be visible after copying`);
}
