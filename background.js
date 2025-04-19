// Track authentication state
let authState = {
    token: null,
    isAuthenticated: false
  };
  
  // Initialize on extension startup
  chrome.runtime.onStartup.addListener(initializeAuth);
  chrome.runtime.onInstalled.addListener(initializeAuth);
  
  async function initializeAuth() {
    try {
      await chrome.identity.clearAllCachedAuthTokens();
      authState = {
        token: null,
        isAuthenticated: false
      };
      await chrome.storage.local.remove(['gmailToken', 'isSignedIn']);
    } catch (error) {
      console.log("Initialization error:", error);
    }
  }
  
  // Message handler with proper error trapping
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handleAsync = async () => {
      try {
        switch (request.action) {
          case "authenticate":
            return await handleAuthentication();
          case "checkOTP":
            return await checkForOTPEmails();
          case "refreshToken":
            return await refreshToken();
          default:
            return { success: false, error: "Unknown action" };
        }
      } catch (error) {
        console.log("Message handler error:", error);
        return { 
          success: false, 
          error: error.message || "An unexpected error occurred" 
        };
      }
    };
  
    handleAsync().then(sendResponse);
    return true; // Keep message channel open
  });
  
  // Improved authentication handler
  async function handleAuthentication() {
    try {
      // Clear any existing tokens
      await chrome.identity.clearAllCachedAuthTokens();
      
      // Get new token with proper error handling
      const token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError;
            if (err.message.includes('OAuth2 not granted or revoked')) {
              console.log("User denied OAuth permission");
              resolve(null);
            } else {
              reject(err);
            }
          } else {
            resolve(token);
          }
        });
      });
  
      if (!token) {
        return { success: false, error: "Authentication denied by user" };
      }
  
      authState = {
        token,
        isAuthenticated: true
      };
  
      await chrome.storage.local.set({ 
        gmailToken: token,
        isSignedIn: true 
      });
  
      return { success: true };
    } catch (error) {
      console.log("Authentication failed:", error);
      return { 
        success: false, 
        error: "Authentication failed" 
      };
    }
  }
  
  // Token management with robust error handling
  async function refreshToken() {
    try {
      // First try silent refresh
      const token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError;
            if (err.message.includes('OAuth2 not granted or revoked')) {
              console.log("Silent refresh failed - needs user interaction");
              resolve(null);
            } else {
              reject(err);
            }
          } else {
            resolve(token);
          }
        });
      });
  
      if (token && await verifyToken(token)) {
        authState.token = token;
        await chrome.storage.local.set({ gmailToken: token });
        return { success: true, token };
      }
  
      // Fall back to interactive auth if silent fails
      return await handleAuthentication();
    } catch (error) {
      console.log("Token refresh failed:", error);
      return { 
        success: false, 
        error: error.message || "Token refresh failed" 
      };
    }
  }
  
  async function verifyToken(token) {
    try {
      const response = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
      if (!response.ok) {
        throw new Error(`Token verification failed: ${response.status}`);
      }
      return true;
    } catch (error) {
      console.log("Token verification error:", error);
      return false;
    }
  }
  
  // OTP checking with comprehensive error handling
  async function checkForOTPEmails() {
    try {
      // Ensure we have a valid token
      let token = authState.token;
      if (!token || !(await verifyToken(token))) {
        const refreshResult = await refreshToken();
        if (!refreshResult.success) {
          return refreshResult;
        }
        token = refreshResult.token;
      }
  
      // Search for OTP emails with broader criteria
      const query = "is:unread (OTP OR verification OR code OR passcode) newer_than:1h";
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 10000 // 10 second timeout
        }
      );
  
      if (!response.ok) {
        throw new Error(`Gmail API error: ${response.status}`);
      }
  
      const { messages } = await response.json();
      
      if (!messages?.length) {
        return { success: false, error: "No recent OTP found" };
      }
  
      // Process messages with error handling for each
      for (const message of messages) {
        try {
          const email = await fetchEmailContent(token, message.id);
          const otp = extractOTP(email);
          
          if (otp) {
            const senderName = extractSenderName(email);
            await processValidOTP(token, message.id, otp, senderName);
            return { success: true, otp, sender: senderName };
          }
        } catch (emailError) {
          console.log("Error processing email:", emailError);
          continue;
        }
      }
  
      return { success: false, error: "No valid OTP found in emails" };
  
    } catch (error) {
      console.log("OTP check failed:", error);
      
      // Handle specific error cases
      if (error.message.includes('401')) {
        await clearAuthData();
        return { 
          success: false, 
          error: "Session expired. Please sign in again." 
        };
      }
      
      return { 
        success: false, 
        error: error.message || "Failed to check for OTP emails" 
      };
    }
  }
  
  // Helper functions with error handling
  async function fetchEmailContent(token, messageId) {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch email: ${response.status}`);
    }
    
    return await response.json();
  }
  
  function extractOTP(emailBody) {
    try {
      const text = parseEmailContent(emailBody);
      const patterns = [
        /(?:^|\n|\r)[\s-]*([A-Z0-9]{6,10})[\s-]*(?:$|\n|\r)/,
        /(?:OTP|verification code)[\s:]*([A-Z0-9]{6,10})/i,
        /(?:^|\s)([A-Z0-9]{6,10})(?:$|\s)/
      ];
  
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
      }
      return null;
    } catch (error) {
      console.log("OTP extraction failed:", error);
      return null;
    }
  }
  
  function parseEmailContent(email) {
    try {
      const parts = email.payload?.parts || [email.payload];
      const textParts = parts.map(part => {
        if (part.mimeType === "text/plain" && part.body?.data) {
          try {
            return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          } catch {
            return '';
          }
        }
        return '';
      });
      return textParts.join('') || email.snippet || '';
    } catch {
      return email.snippet || '';
    }
  }
  
  function extractSenderName(email) {
    try {
      const fromHeader = email.payload.headers?.find(h => h.name === "From")?.value || "";
      return fromHeader
        .replace(/<[^>]*>/g, '')
        .replace(/["']/g, '')
        .trim()
        .split('@')[0] 
        || "unknown sender";
    } catch {
      return "unknown sender";
    }
  }
  
  async function processValidOTP(token, emailId, otp, sender) {
    await Promise.all([
      saveOTPData(emailId, otp, sender),
      autoFillOTP(otp),
      markEmailAsRead(token, emailId)
    ]);
  }
  
  async function saveOTPData(emailId, otp, sender) {
    await chrome.storage.local.set({
      lastProcessedEmailId: emailId,
      lastOTP: otp,
      lastOTPTime: Date.now(),
      lastSender: sender
    });
  }
  
  async function autoFillOTP(otp) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
  
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (otpToFill) => {
          const inputs = [
            ...document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')
          ].filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          
          if (inputs.length > 0) {
            // Sort by visual position
            inputs.sort((a, b) => {
              const aRect = a.getBoundingClientRect();
              const bRect = b.getBoundingClientRect();
              return aRect.top - bRect.top || aRect.left - bRect.left;
            });
            
            const target = inputs[0];
            target.value = otpToFill;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        args: [otp]
      });
    } catch (error) {
      console.log("Auto-fill failed:", error);
    }
  }
  
  async function markEmailAsRead(token, messageId) {
    try {
      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
        {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
        }
      );
    } catch (error) {
      console.log("Failed to mark email as read:", error);
    }
  }
  
  async function clearAuthData() {
    try {
      await chrome.identity.clearAllCachedAuthTokens();
      await chrome.storage.local.remove([
        'gmailToken', 
        'isSignedIn',
        'lastProcessedEmailId',
        'lastOTP',
        'lastOTPTime',
        'lastSender'
      ]);
      authState = {
        token: null,
        isAuthenticated: false
      };
    } catch (error) {
      console.log("Failed to clear auth data:", error);
    }
  }