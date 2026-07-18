1. Do not apply or attempt [this assignment if this role is not open](https://www.ycombinator.com/companies/drdroid/jobs/w45QcNV-product-engineer-assignment-mandatory).  
2. Please don’t attempt to build this without coding agents.

**Objective:** Build a functional deep research AI Agent, “MicroManus” with usage based billing system integrated.

**What needs to be delivered:**

* A web UI, call it “MicroManus” where a person can sign up (only social login \- github or google is ok). After signup, user must be shown a paywall. This paywall can only be bypassed using a coupon code SID\_DRDROID. Or by actually adding a credit card and paying $5. In either case, user receives 5 credits.  
* A web ui to chat with an agent which has access to the internet and can have conversation threads.  
  * It should hold context of conversation within the same chat.  
  * The agent should be able to operate in a loop: think → do call → see output, understand → think again → more tool call, etc. (E.g. think the agent is given a prompt: “Create a report explaining the recent forest fires in California, what are causing it and what can be done to avoid it”  
  * There should be capability to start new chats.  
  * The agent should have capability to create a report (PDF) as an artifact if needed.  
* The agent should have caching in place with OpenAI compatible key & endpoint.  
  * If I put my key, I should be able to chat.  
  * Support 3-4 latest popular Claude, OpenAI and Kimi models  
* After multiple chats, there should be a page where I can see the cost & stats of each chat.  
  * Cost to be calculated based on the model connected.  
  * Cost to be distributed by input / output / cache tokens.  
  * Cost should be as per model selected while adding the key.

**What a good submission looks like:** (hint: definite review and v v high chance of feedback over email)

* You share a sign up URL. Everything else has to be self-explanatory.

**What great outcome looks like:** (hint: guaranteed response and v v high chance of interview)

* Actually functional flow to add a credit card and get approved.

**Tips:**

* Use free / openly available technologies:  
  * Brave Search API  
  * Supabase  
  * Stripe developer testing account or any other payment gateway  
* Explore cutting edge deep research agents like Perplexity and Manus to get a vibe of the UX / capability comparison.  
* Use agentic coding, but know your stuff. Get your friends to test the entire requirement shared above. A submission that doesn’t work will disqualify you directly.

**Instructions:**

* Do not pre-load LLM key in your app. User should put the API key.  
* This cannot be a github repo or localhost. Need a weburl.  
* This assignment should take you 2-4 hours to complete. 

**Submissions:**

* Send the URL to sign up to Siddarth over email.