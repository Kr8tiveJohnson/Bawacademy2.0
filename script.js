/**
 * The Bridge Business Academy x Spotless Connect
 * Business & Skill Up Acquisition 2.0 Workshop
 * Interactive Application Script
 */

// ── Global Helper: Toggle Mobile Navigation Drawer ──────────
window.toggleMobileNav = function(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    const btn = document.querySelector("#menu-toggle");
    const nav = document.querySelector("#mobile-nav");
    if (!btn || !nav) return;
    const isExpanded = btn.getAttribute("aria-expanded") === "true";
    const willExpand = !isExpanded;
    btn.setAttribute("aria-expanded", String(willExpand));
    if (willExpand) {
        nav.classList.add("is-open");
        nav.setAttribute("aria-hidden", "false");
    } else {
        nav.classList.remove("is-open");
        nav.setAttribute("aria-hidden", "true");
    }
};

// ── Global Helper: Poster Lightbox Modal ───────────────────
window.openFlyerModal = function(e) {
    if (e && e.preventDefault) e.preventDefault();
    const modal = document.querySelector("#flyerModal");
    if (modal) {
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
    }
};

window.closeFlyerModal = function(e) {
    if (e && e.preventDefault) e.preventDefault();
    const modal = document.querySelector("#flyerModal");
    if (modal) {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
    }
};

// ── Universal Smooth Scroll for all Anchor Links ──────────
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener("click", function(e) {
            const targetId = this.getAttribute("href");
            if (targetId && targetId !== "#" && targetId !== "#top") {
                const targetEl = document.querySelector(targetId);
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

document.addEventListener("DOMContentLoaded", () => {
    initSmoothScroll();

    // 1. Scrolled header state
    const siteHeader = document.querySelector("#header");
    if (siteHeader) {
        const onScroll = () => {
            siteHeader.classList.toggle("scrolled", window.scrollY > 20);
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
    }

    // 2. Mobile Menu Drawer Toggle
    const menuToggle = document.querySelector("#menu-toggle");
    const mobileNav = document.querySelector("#mobile-nav");

    if (menuToggle && mobileNav) {
        menuToggle.addEventListener("click", window.toggleMobileNav);

        // Smooth navigation and delayed close on mobile link click
        const mobileLinks = mobileNav.querySelectorAll("a");
        mobileLinks.forEach((link) => {
            link.addEventListener("click", (event) => {
                const href = link.getAttribute("href");
                if (href && href.startsWith("#")) {
                    const targetEl = document.querySelector(href);
                    if (targetEl) {
                        event.preventDefault();
                        targetEl.scrollIntoView({ behavior: "smooth" });
                    }
                }
                setTimeout(() => {
                    menuToggle.setAttribute("aria-expanded", "false");
                    mobileNav.classList.remove("is-open");
                    mobileNav.setAttribute("aria-hidden", "true");
                }, 180);
            });
        });

        // Close on ESC key
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
                menuToggle.setAttribute("aria-expanded", "false");
                mobileNav.classList.remove("is-open");
                mobileNav.setAttribute("aria-hidden", "true");
                menuToggle.focus();
            }
        });

        // Close when clicking outside of header
        document.addEventListener("click", (event) => {
            const header = document.querySelector("#header");
            if (menuToggle.getAttribute("aria-expanded") === "true" && header && !header.contains(event.target)) {
                menuToggle.setAttribute("aria-expanded", "false");
                mobileNav.classList.remove("is-open");
                mobileNav.setAttribute("aria-hidden", "true");
            }
        });
    }

    // 2. Dynamic Year Update
    const currentYearSpan = document.querySelector("#current-year");
    if (currentYearSpan) {
        currentYearSpan.textContent = String(new Date().getFullYear());
    }

    // 3. Interactive Form Handling (Inspired by Badagry Summit)
    const form = document.querySelector("#workshop-registration-form");
    const formStatus = document.querySelector("#formStatus");
    const submitBtn = document.querySelector("#submitBtn");

    if (form) {
        form.addEventListener("submit", (e) => {
            e.preventDefault();

            // Clear previous errors
            document.querySelectorAll(".form-group").forEach(fg => fg.classList.remove("has-error"));
            formStatus.className = "form-status";
            formStatus.style.display = "none";

            let isValid = true;

            const fullName = document.querySelector("#fullName");
            const phone = document.querySelector("#phone");
            const email = document.querySelector("#email");
            const institution = document.querySelector("#institution");
            const location = document.querySelector("#location");
            const consent = document.querySelector("#consent");
            const interestCheckboxes = document.querySelectorAll('input[name="interests"]:checked');

            // Validate Full Name
            if (!fullName.value.trim()) {
                fullName.closest(".form-group").classList.add("has-error");
                isValid = false;
            }

            // Validate Phone
            if (!phone.value.trim() || phone.value.trim().length < 8) {
                phone.closest(".form-group").classList.add("has-error");
                isValid = false;
            }

            // Validate Email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!email.value.trim() || !emailRegex.test(email.value.trim())) {
                email.closest(".form-group").classList.add("has-error");
                isValid = false;
            }

            // Validate Institution
            if (!institution.value.trim()) {
                institution.closest(".form-group").classList.add("has-error");
                isValid = false;
            }

            // Validate Location
            if (!location.value.trim()) {
                location.closest(".form-group").classList.add("has-error");
                isValid = false;
            }

            // Validate Interests
            if (interestCheckboxes.length === 0) {
                const interestGroup = document.querySelector(".skills-checkbox-grid").closest(".form-group");
                interestGroup.classList.add("has-error");
                isValid = false;
            }

            // Validate Consent
            if (!consent.checked) {
                consent.closest(".form-consent").classList.add("has-error");
                isValid = false;
            }

            if (!isValid) {
                formStatus.textContent = "Please fill in all required fields marked with an asterisk (*).";
                formStatus.classList.add("is-error");
                formStatus.style.display = "block";
                return;
            }

            // Simulated Submission & WhatsApp Handoff
            const originalBtnText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span>Processing Seat Reservation...</span>`;

            setTimeout(() => {
                const selectedInterests = Array.from(interestCheckboxes).map(cb => cb.value).join(", ");
                const candidateName = fullName.value.trim();

                // Store in localStorage for persistence
                const submissionData = {
                    name: candidateName,
                    phone: phone.value.trim(),
                    email: email.value.trim(),
                    institution: institution.value.trim(),
                    location: location.value.trim(),
                    interests: selectedInterests,
                    timestamp: new Date().toISOString()
                };
                try {
                    localStorage.setItem("tbba_workshop_registration", JSON.stringify(submissionData));
                } catch (err) {
                    // Ignore storage errors if private browsing
                }

                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span>✓ Place Reserved!</span>`;

                const encodedWaText = encodeURIComponent(
                    `Hello The Bridge Business Academy, I have pre-registered for the Skill Up 2.0 Workshop!\n\n` +
                    `*Name:* ${candidateName}\n` +
                    `*Phone:* ${phone.value.trim()}\n` +
                    `*Institution/Job:* ${institution.value.trim()}\n` +
                    `*Location:* ${location.value.trim()}\n` +
                    `*Interests:* ${selectedInterests}`
                );

                formStatus.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <strong>🎉 Congratulations, ${candidateName}! Your priority place has been recorded.</strong>
                        <p style="margin: 0; font-size: 0.9em;">We have saved your details for the November 2026 workshop announcements, scholarship screenings, and brand job notifications.</p>
                        <a href="https://wa.me/2347081755387?text=${encodedWaText}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: #25d366; color: #072e17; font-weight: 800; padding: 10px 16px; border-radius: 6px; margin-top: 6px; text-decoration: none;">
                            💬 Click Here to Confirm Instantly on WhatsApp (+234 708 175 5387)
                        </a>
                    </div>
                `;
                formStatus.classList.add("is-success");
                formStatus.style.display = "block";

                form.reset();
            }, 800);
        });
    }

    // 4. Header Shadow On Scroll
    const header = document.querySelector(".site-header");
    if (header) {
        window.addEventListener("scroll", () => {
            if (window.scrollY > 20) {
                header.style.boxShadow = "0 8px 30px rgba(0, 0, 0, 0.4)";
            } else {
                header.style.boxShadow = "0 4px 20px rgba(0, 0, 0, 0.2)";
            }
        }, { passive: true });
    }

    // 5. Official Poster Lightbox Modal
    const posterTrigger = document.querySelector("#heroPosterTrigger");
    const flyerModal = document.querySelector("#flyerModal");
    const flyerModalClose = document.querySelector("#flyerModalClose");
    const flyerModalBackdrop = document.querySelector("#flyerModalBackdrop");
    const modalRegisterBtn = document.querySelector("#modalRegisterBtn");

    if (posterTrigger && flyerModal) {
        const openModal = () => {
            flyerModal.classList.add("is-open");
            flyerModal.setAttribute("aria-hidden", "false");
            document.body.style.overflow = "hidden";
        };

        const closeModal = () => {
            flyerModal.classList.remove("is-open");
            flyerModal.setAttribute("aria-hidden", "true");
            document.body.style.overflow = "";
        };

        posterTrigger.addEventListener("click", openModal);
        posterTrigger.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openModal();
            }
        });

        if (flyerModalClose) flyerModalClose.addEventListener("click", closeModal);
        if (flyerModalBackdrop) flyerModalBackdrop.addEventListener("click", closeModal);
        if (modalRegisterBtn) modalRegisterBtn.addEventListener("click", closeModal);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && flyerModal.classList.contains("is-open")) {
                closeModal();
            }
        });
    }
});
