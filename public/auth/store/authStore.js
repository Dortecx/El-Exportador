"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var zustand_1 = require("zustand");
var useAuthStore = (0, zustand_1.create)(function (set) { return ({
    isAuthenticated: false,
    token: null,
    provider: null,
    setCredentials: function (token, provider) { return set({
        isAuthenticated: true,
        token: token,
        provider: provider,
    }); },
    clearCredentials: function () { return set({
        isAuthenticated: false,
        token: null,
        provider: null,
    }); },
}); });
// Exponer el store globalmente para que el frontend pueda acceder a él
if (typeof window !== 'undefined') {
    window.authStore = useAuthStore;
}
exports.default = useAuthStore;
