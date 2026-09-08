import test from "node:test"
import assert from "node:assert/strict"

import { resolveModuleFromPath } from "./moduleTheme.js"

/**
 * Which app a path is themed as.
 *
 * applyModulePowerScanning rewrites every bg-teal/emerald/green class with
 * !important, so getting this wrong for one route repaints the whole chrome.
 * The admin sidebar is bg-teal-800 and the customer app is pink, which is what
 * the intermittent pink sidebar was.
 */

test("every admin route is themed as admin", () => {
    for (const path of [
        "/admin",
        "/admin/food",
        "/admin/food/orders/all",
        "/admin/food/fee-settings",
        "/admin/login",
    ]) {
        assert.equal(resolveModuleFromPath(path), "admin", path)
    }
})

test("the customer, restaurant and delivery apps keep their own themes", () => {
    assert.equal(resolveModuleFromPath("/"), "user")
    assert.equal(resolveModuleFromPath("/food"), "user")
    assert.equal(resolveModuleFromPath("/food/restaurant"), "restaurant")
    assert.equal(resolveModuleFromPath("/food/restaurant/orders"), "restaurant")
    assert.equal(resolveModuleFromPath("/food/delivery"), "delivery")
})

test("a path that looks like admin but is not does not get the admin theme", () => {
    // The customer app could have a page about administrators; only the /admin
    // prefix is the panel.
    assert.equal(resolveModuleFromPath("/food/administration"), "user")
    assert.equal(resolveModuleFromPath("/administrator"), "user")
})

test("nothing at all falls back to the customer app", () => {
    for (const empty of ["", null, undefined]) {
        assert.equal(resolveModuleFromPath(empty), "user", JSON.stringify(empty))
    }
})
