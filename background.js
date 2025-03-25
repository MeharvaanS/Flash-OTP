// Track last filled OTP globally
let lastFilledOTP = null;

// Handle authentication and messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "authenticate") {
        handleAuthentication(sendResponse);
        return true;
    }
    
    if (request.action === "checkOTP") {
        checkForOTPEmails().then((result) => {
            sendResponse(result);
        });
        return true;
    }
});

// Handle Google authentication
function handleAuthentication(sendResponse) {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
            console.log("Auth error:", chrome.runtime.lastError);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
        }
        
        if (!token) {
            sendResponse({ success: false, error: "No token received" });
            return;
        }
        
        console.log("🔑 Token received");
        chrome.storage.local.set({ 
            gmailToken: token,
            isSignedIn: true
        });
        sendResponse({ success: true });
    });
}

// Enhanced OTP extraction with strict criteria
function extractOTP(emailBody) {
    try {
        let text = emailBody;
        
        // Parse email structure
        if (typeof emailBody === 'object') {
            const parts = emailBody.payload?.parts || [emailBody.payload];
            text = parts.map(part => {
                if (part.mimeType === "text/plain" && part.body?.data) {
                    return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
                }
                return '';
            }).join('');

            // Fallback to snippet if no plain text part found
            if (!text.trim() && emailBody.snippet) {
                text = emailBody.snippet;
            }
        }

        // First check if email contains OTP-related keywords (case insensitive)
        const otpKeywords = [
            'one[- ]?time (?:passcode|password)',
            'otp',
            'verification code',
            'authentication code',
            'security code'
        ];
        
        const keywordPattern = new RegExp(otpKeywords.join('|'), 'i');
        if (!keywordPattern.test(text)) {
            return null; // Skip emails without OTP keywords
        }

        // Specialized pattern for codes with significant spacing
        const spacedCodePattern = /(?:^|\n|\r)[\s-]*([A-Z0-9]{6,10})[\s-]*(?:$|\n|\r)/;
        
        // Alternative patterns if the first one fails
        const fallbackPatterns = [
            // Pattern for labeled codes with spacing
            /(?:one[- ]?time (?:passcode|password)|OTP|verification code)[\s:]*([A-Z0-9]{6,10})(?=\s|$|\.|,|\)|\n|\r)/i,
            
            // General standalone code pattern
            /(?:^|\s)([A-Z0-9]{6,10})(?:$|\s|\.|,|\)|\n|\r)/
        ];

        // Try the spaced pattern first
        let match = text.match(spacedCodePattern);
        if (match) {
            return match[1];
        }

        // Fallback to other patterns if needed
        for (const pattern of fallbackPatterns) {
            match = text.match(pattern);
            if (match) {
                return match[1];
            }
        }
        
        return null;
    } catch (error) {
        console.log("OTP extraction error:", error);
        return null;
    }
}

// Fetch email content
async function fetchEmailContent(token, messageId) {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return await response.json();
}

// Main OTP checking function
async function checkForOTPEmails() {
    console.log("\n===== 🔄 OTP Check at:", new Date().toLocaleTimeString(), "=====");
    
    // Clear all previous tracking data
    await chrome.storage.local.remove([
        'lastProcessedEmailId',
        'lastOTP',
        'lastOTPTime',
        'lastSender'
    ]);

    const { gmailToken } = await chrome.storage.local.get(['gmailToken']);
    if (!gmailToken) {
        console.log("❌ No Gmail token");
        return { success: false, error: "Not authenticated" };
    }

    try {
        // Search only for brand new unread emails from the last 2 minutes
        const query = "is:unread newer_than:2m";
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${gmailToken}` }
        });
        
        const data = await response.json();
        if (!data.messages?.length) {
            console.log("📭 No new OTP emails");
            return { success: false, error: "No new OTP emails found" };
        }

        // Process messages from newest to oldest
        for (const message of data.messages) {
            const email = await fetchEmailContent(gmailToken, message.id);
            const otp = extractOTP(email);
            
            if (otp) {
                // Extract sender name from email headers
                let senderName = "unknown sender";
                const headers = email.payload.headers || [];
                const fromHeader = headers.find(h => h.name === "From");
                if (fromHeader) {
                    // Clean up sender name (remove email and special characters)
                    senderName = fromHeader.value
                        .replace(/<[^>]*>/g, '') // Remove email part
                        .replace(/["']/g, '')     // Remove quotes
                        .replace(/\s{2,}/g, ' ')  // Remove extra spaces
                        .trim();
                    
                    // If we're left with nothing (was just email), use a default
                    if (!senderName) senderName = "a service";
                }

                console.log("🎉 Found NEW OTP:", otp, "from:", senderName);
                
                // Store the message ID and sender to prevent duplicate processing
                await chrome.storage.local.set({ 
                    lastProcessedEmailId: message.id,
                    lastOTP: otp,
                    lastOTPTime: Date.now(),
                    lastSender: senderName
                });

                // Fill OTP in current tab
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab?.id) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            function: fillFirstInput,
                            args: [otp]
                        });
                    } catch (error) {
                        console.log("Failed to fill OTP:", error);
                    }
                }

                // Immediately mark as read to prevent future detection
                await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}/modify`, {
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bearer ${gmailToken}`,
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({ 
                        removeLabelIds: ['UNREAD'],
                        addLabelIds: ['TRASH'] // Optionally move to trash
                    })
                });
                
                return { success: true, otp: otp };
            }
        }
        
        return { success: false, error: "No valid OTP found in new emails" };
    } catch (error) {
        console.log("💥 OTP check failed:", error);
        return { success: false, error: "Error checking for OTP" };
    }
}

// Function to fill OTP in the first input field
function fillFirstInput(otp) {
    // Find the first non-hidden input element on the page
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const allFields = [...inputs, ...textareas].sort((a, b) => {
        // Sort by visual position (top to bottom, left to right)
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.top - rectB.top || rectA.left - rectB.left;
    });

    if (allFields.length > 0) {
        const firstField = allFields[0];
        console.log(allFields);
        firstField.value = otp;
        
        // Trigger events to simulate real input
        firstField.dispatchEvent(new Event('input', { bubbles: true }));
        firstField.dispatchEvent(new Event('change', { bubbles: true }));
        
        console.log("✅ Filled OTP in first input field:", firstField);
        return true;
    }
    
    console.log("❌ No input field found");
    return false;
}