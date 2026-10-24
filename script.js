/**
 * The Bridge Business Academy x Spotless Connect
 * Business & Skill Up Acquisition 2.0 Workshop
 * Interactive Application Script
 */

// ── Mobile Navigation Drawer Controller ─────────────────────
(function () {
    var lastToggleTime = 0;
    var isNavOpen = false;

    function doToggle(e) {
        if (e) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
        }

        var now = Date.now();
        // Debounce touch/click within 300ms to prevent double toggling on mobile
        if (now - lastToggleTime < 300) return;
        lastToggleTime = now;

        var btn = document.getElementById("menu-toggle");
        var nav = document.getElementById("mobile-nav");
        if (!btn || !nav) return;

        isNavOpen = !isNavOpen;

        if (isNavOpen) {
            nav.classList.add("is-open");
            nav.style.display = "block";
            nav.setAttribute("aria-hidden", "false");
            btn.setAttribute("aria-expanded", "true");
            btn.classList.add("is-active");
            document.body.classList.add("mobile-menu-open");
        } else {
            nav.classList.remove("is-open");
            nav.style.display = "none";
            nav.setAttribute("aria-hidden", "true");
            btn.setAttribute("aria-expanded", "false");
            btn.classList.remove("is-active");
            document.body.classList.remove("mobile-menu-open");
        }
    }

    function closeNav() {
        var btn = document.getElementById("menu-toggle");
        var nav = document.getElementById("mobile-nav");
        if (!btn || !nav) return;
        isNavOpen = false;
        nav.classList.remove("is-open");
        nav.style.display = "none";
        nav.setAttribute("aria-hidden", "true");
        btn.setAttribute("aria-expanded", "false");
        btn.classList.remove("is-active");
        document.body.classList.remove("mobile-menu-open");
    }

    // Expose globally for HTML onclick handlers
    window.toggleMobileNav = doToggle;
    window.closeMobileNav = closeNav;

    function initMobileNav() {
        var btn = document.getElementById("menu-toggle");
        var nav = document.getElementById("mobile-nav");
        var header = document.getElementById("header");

        if (btn) {
            btn.onclick = function (e) {
                doToggle(e);
            };
        }

        if (nav) {
            var links = nav.querySelectorAll("a");
            links.forEach(function (link) {
                link.addEventListener("click", function () {
                    setTimeout(closeNav, 160);
                });
            });
        }

        // Close on clicking outside
        document.addEventListener("click", function (e) {
            if (!isNavOpen || Date.now() - lastToggleTime < 350) return;
            if (btn && (btn === e.target || btn.contains(e.target))) return;
            if (nav && (nav === e.target || nav.contains(e.target))) return;
            if (header && header.contains(e.target) && !e.target.closest("a")) return;
            closeNav();
        });

        // Close on ESC
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && isNavOpen) {
                closeNav();
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initMobileNav);
    } else {
        initMobileNav();
    }
}());

// ── Global Helper: Poster Lightbox Modal ───────────────────
window.openFlyerModal = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    var modal = document.querySelector("#flyerModal");
    if (modal) {
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
    }
};

window.closeFlyerModal = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    var modal = document.querySelector("#flyerModal");
    if (modal) {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
    }
};

// ── Global Helper: Paystack Pre-Register Modal ──────────────
window.openPaystackModal = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    var modal = document.querySelector("#payModalBackdrop");
    if (modal) {
        modal.style.display = "flex";
        // Force reflow for animation
        modal.offsetHeight;
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
        var nameInput = document.getElementById("payModalName");
        var referralInput = document.getElementById("payModalReferral");
        if (referralInput && !referralInput.value) {
            // Read referral code directly from URL query param (?ref=BAW-5K-...)
            try {
                var params = new URLSearchParams(window.location.search);
                var urlRef = params.get("ref");
                if (urlRef) {
                    referralInput.value = urlRef.trim().toUpperCase();
                    verifyReferralCode(referralInput.value);
                }
            } catch (e) {}
        }
        if (nameInput) setTimeout(function () { nameInput.focus(); }, 120);
    }
};

window.closePaystackModal = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    var modal = document.querySelector("#payModalBackdrop");
    if (modal) {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        setTimeout(function () {
            modal.style.display = "none";
        }, 220);
        document.body.style.overflow = "";
    }
};

window.handlePayInitSubmit = async function (e) {
    if (e && e.preventDefault) e.preventDefault();
    var btn = document.getElementById("payInitSubmitBtn");
    var nameInput = document.getElementById("payModalName");
    var emailInput = document.getElementById("payModalEmail");
    var refInput = document.getElementById("payModalReferral");
    var referredBy = refInput ? refInput.value.trim().toUpperCase() : "";

    if (!emailInput || !emailInput.value.trim() || !emailInput.value.includes("@")) {
        alert("Please enter a valid email address to receive your ticket confirmation.");
        return;
    }

    var originalHtml = btn ? btn.innerHTML : "";
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>Connecting to Paystack...</span> <span>⏳</span>';
    }

    try {
        var res = await fetch('/api/paystack/initialize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: nameInput ? nameInput.value.trim() : '',
                email: emailInput.value.trim(),
                referredBy: referredBy
            })
        });

        var data = await res.json();
        if (!res.ok || !data.success || !data.authorization_url) {
            throw new Error(data.error || 'Failed to initialize payment.');
        }

        // Direct student to official Paystack checkout
        window.location.href = data.authorization_url;
    } catch (err) {
        alert("Payment Gateway Error: " + err.message);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
};

// ── Database-Backed Referral Code Verification ──
async function verifyReferralCode(code) {
    var feedback = document.getElementById("payModalReferralFeedback");
    if (!code || code.length < 6) {
        if (feedback) { feedback.textContent = ""; feedback.style.display = "none"; }
        return;
    }
    if (feedback) {
        feedback.textContent = "Verifying...";
        feedback.style.color = "#94a3b8";
        feedback.style.display = "block";
    }
    try {
        var res = await fetch("/api/referrals/verify?code=" + encodeURIComponent(code));
        var data = await res.json();
        if (feedback) {
            if (data.valid) {
                feedback.innerHTML = "✅ <strong>" + data.name + "</strong>'s referral code verified";
                feedback.style.color = "#4ade80";
            } else {
                feedback.textContent = "❌ Code not found in our database";
                feedback.style.color = "#f87171";
            }
            feedback.style.display = "block";
        }
    } catch (e) {
        if (feedback) { feedback.textContent = ""; feedback.style.display = "none"; }
    }
}

// Auto-verify referral code when the user leaves the input field
(function () {
    document.addEventListener("DOMContentLoaded", function () {
        var refInput = document.getElementById("payModalReferral");
        if (refInput) {
            refInput.addEventListener("blur", function () {
                verifyReferralCode(refInput.value.trim().toUpperCase());
            });
        }
    });

    // If URL has ?ref=..., auto-open the modal after a short delay
    try {
        var params = new URLSearchParams(window.location.search);
        var ref = params.get("ref");
        if (ref && ref.trim()) {
            window.addEventListener("DOMContentLoaded", function () {
                setTimeout(function () { window.openPaystackModal(); }, 600);
            });
        }
    } catch (e) {}
})();

// ── Universal Smooth Scroll for in-page anchors ────────────
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener("click", function (e) {
            var targetId = this.getAttribute("href");
            if (targetId && targetId !== "#" && targetId !== "#top") {
                var targetEl = document.querySelector(targetId);
                if (targetEl) {
                    e.preventDefault();
                    targetEl.scrollIntoView({ behavior: "smooth" });
                }
            } else if (targetId === "#top") {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
            }
        });
    });
}

document.addEventListener("DOMContentLoaded", function () {
    initSmoothScroll();

    // 1. Scrolled header state
    var siteHeader = document.querySelector("#header");
    if (siteHeader) {
        var onScroll = function () {
            siteHeader.classList.toggle("scrolled", window.scrollY > 20);
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
    }

    // 2. Dynamic Year Update
    var currentYearSpan = document.querySelector("#current-year");
    if (currentYearSpan) {
        currentYearSpan.textContent = String(new Date().getFullYear());
    }

    // 3. Official Poster Lightbox Modal
    var posterTrigger = document.querySelector("#heroPosterTrigger");
    var flyerModal = document.querySelector("#flyerModal");
    var flyerModalClose = document.querySelector("#flyerModalClose");
    var flyerModalBackdrop = document.querySelector("#flyerModalBackdrop");
    var modalRegisterBtn = document.querySelector("#modalRegisterBtn");

    if (posterTrigger && flyerModal) {
        posterTrigger.addEventListener("click", window.openFlyerModal);
        posterTrigger.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                window.openFlyerModal();
            }
        });

        if (flyerModalClose) flyerModalClose.addEventListener("click", window.closeFlyerModal);
        if (flyerModalBackdrop) flyerModalBackdrop.addEventListener("click", window.closeFlyerModal);
        if (modalRegisterBtn) modalRegisterBtn.addEventListener("click", window.closeFlyerModal);

        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && flyerModal.classList.contains("is-open")) {
                window.closeFlyerModal();
            }
        });
    }

    // 4. Paystack Pre-Register Modal Listeners
    var payModalClose = document.querySelector("#payModalClose");
    var payModalBackdrop = document.querySelector("#payModalBackdrop");
    if (payModalClose) {
        payModalClose.addEventListener("click", window.closePaystackModal);
    }
    if (payModalBackdrop) {
        payModalBackdrop.addEventListener("click", function (e) {
            if (e.target === payModalBackdrop) {
                window.closePaystackModal();
            }
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && payModalBackdrop.classList.contains("is-open")) {
                window.closePaystackModal();
            }
        });
    }

    // Auto-open modal if URL has #pre-register
    if (window.location.hash === "#pre-register") {
        setTimeout(function () {
            if (typeof window.openPaystackModal === "function") {
                window.openPaystackModal();
            }
        }, 350);
    }

    // ── Cybersecurity Client-Side Protection & Anti-Inspect Deterrents ──
    (function () {
        var toastTimer = null;
        function showSecurityNotice() {
            var existing = document.getElementById("cyberSecurityToast");
            if (!existing) {
                existing = document.createElement("div");
                existing.id = "cyberSecurityToast";
                existing.innerHTML = "🛡️ <strong>Security Protected:</strong> Source viewing & inspect tools are disabled.";
                existing.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);" +
                    "background:rgba(4,20,12,0.96);color:#f1f5f9;border:1px solid #e6b749;padding:12px 22px;border-radius:999px;" +
                    "font-size:0.85rem;font-family:sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.7);z-index:999999;opacity:0;" +
                    "pointer-events:none;transition:transform 0.3s cubic-bezier(0.16,1,0.3,1), opacity 0.3s ease;";
                document.body.appendChild(existing);
            }
            clearTimeout(toastTimer);
            requestAnimationFrame(function () {
                existing.style.transform = "translateX(-50%) translateY(0)";
                existing.style.opacity = "1";
            });
            toastTimer = setTimeout(function () {
                existing.style.transform = "translateX(-50%) translateY(100px)";
                existing.style.opacity = "0";
            }, 2600);
        }

        // Disable Context Menu (Right Click)
        document.addEventListener("contextmenu", function (e) {
            // Allow right click inside form inputs if user is typing
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            e.preventDefault();
            showSecurityNotice();
            return false;
        }, { capture: true });

        // Disable Developer Tools & View-Source Keyboard Shortcuts
        document.addEventListener("keydown", function (e) {
            if (e.key === "F12") {
                e.preventDefault();
                showSecurityNotice();
                return false;
            }
            if ((e.ctrlKey || e.metaKey) && (
                e.key === "u" || e.key === "U" ||
                e.key === "s" || e.key === "S" ||
                ((e.shiftKey || e.altKey) && (e.key === "i" || e.key === "I" || e.key === "j" || e.key === "J" || e.key === "c" || e.key === "C"))
            )) {
                e.preventDefault();
                showSecurityNotice();
                return false;
            }
        }, { capture: true });

        // Self-XSS & Probing Warning Banner in Console
        try {
            console.log(
                "%c🛡️ SECURITY ADVISORY%c\nThis is a protected academy application. Tampering, unauthorized scripting, or injection attempts are actively monitored and logged.",
                "color: #e6b749; font-size: 18px; font-weight: bold; background: #03140b; padding: 4px 8px; border-radius: 4px; border: 1px solid #e6b749;",
                "color: #94a3b8; font-size: 13px; line-height: 1.5;"
            );
        } catch (err) {}
    })();
});

