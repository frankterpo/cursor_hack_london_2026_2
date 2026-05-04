# Hackathon format

<aside>

Thrilled to see the Cursor community come together to build stuff. Here are some best practices for setting up a successful Cursor hackathon.

Questions? Ping our team on Slack or email!

</aside>

### Setup

- Finding a venue where people can work together is the first part you’ll need to figure out
- Make sure they have strong wifi ahead of time and can support the number of attendees you’re aiming for
- Can be helpful to create a group chat for attendees to coordinate and stay up to date with the schedule and what’s happening.
- Bring some name tags so that people can find each other
- Decide who your target audience is. Are you aiming for power users? Beginners? A mix. Best to be thoughtful with who you want to come. You can ask in the Luma what kind of experience they have with Cursor.
- You can decide on a theme or keep it open with some suggested directions.  Our recommendation though would be to provide a few specific themes or topics to help with ideation and encourage people who don't know each other to group together based on shared interests. Without themes, people tend to group with those they already know.

- Some matchmaking is usually really good for finding/creating teams. Can be a simple “I have a team” and “I’m looking for a team.”
- Having more than one person run the event, help shortlist finalists, coordinate presenters is key. Ideally you want to have a few people helping out.
- Be clear on judgement criteria upfront

### Promotion

- Just like with meetups, we can email local power users to let them know about the hackathon. Instructions [here](https://www.notion.so/1deba798b53c800d9513d964043a1b4a?pvs=21).
- Make sure to create a Luma page and submit to the Cursor community calendar [here](lu.ma/cursorcommunity)
- We also recommend sharing on X, LinkedIn and any other social networks you use. Feel free to share any posts in #events on Slack for amplification.

### Partners

- If you have any other partners for the event, please list them this way, using this format. Feel free to add them to the description, email blasts, hosts as well.
    
    ![image.png](Hackathon%20format/image.png)
    
- We prefer for it still to be called a Cursor Hackathon so that Cursor is front and center in the branding.
- In general, it’s best to confirm the sponsor with Ben Lang before bringing them on. But there are some sponsors with whom we’ve worked that have been vetted:
    - ElevenLabs ⇒ message Victor Patru in Slack for an introduction. They usually only offer credits to participants and winners
    - Convex ⇒ message [Wayne Sutton](https://x.com/waynesutton) directly on Twitter (feel free to mention you’ve heard about this opportunity from Victor Patru)
    - More here:
        - ‣

### Timing

- So far this has been entirely experimental. The shortest so far has been 60 minutes to build stuff. You can of course go for a couple hours, totally up to you. We do think there’s something really cool about hackathons being short compared to how long they were a few years ago pre AI.
    - 3 hours has been the optimal length session so far from those who’ve organized these
    - You can absolutely make it longer, totally up to you.
- You’ll want to make sure there’s time before the actual building session for attendees get set up and ready to go.
- After the build session, it’s nice for people to see what people were able to make. Make sure you’re strict on how long each team or participant can present for. Set an alarm clock so that people don’t go over.
- @Emre OZCAN built a cool timer to use which you can access here: https://cursor-hackathon-timer.vercel.app/

### Cursor Credits usage

- We will generate a list of unique URLs for you to share with attendees to redeem Cursor credits for the event.
- Important Notice (Jan 2026): **No more pro trial for new users**, including hackathons and events.
- **Payment Method:** Users *must* have a payment method on file to redeem Cursor credits.
- **Regional Setup:** Regional payment issues may affect some participants. As a backup solution, organizers can use a shared Cursor team account for regions with payment provider issues (only recommended when individual signup is impossible). Users should use a new email to avoid disrupting personal accounts, as joining a team ends a previous subscription.
- **Credit Distribution Methods:**
    - Give everyone individual credits, even if they submit together at the end. Each team must list all its members.
    - *Method 1:* Platform with Luma check-in CSV (search name → get cursor link). Only for those who attend the event in person.
    - *Method 2:* Find the organizer during the event for limited redemption codes.
    - **Crucial:** Avoid using open links (codes get leaked and depleted within seconds).
- Note: Certain features like Background Agents / Web do not work without a paid plan

### Distributing credits

1. If you have under 100 participants and don’t mind the setup, @Victor Patru build a helpful tool to distribute the links:
    - It emails links to users listed in a CSV (needs a Resend API key, free plan limited to 100 emails/day)
    - Access here: https://github.com/cursorcommunityled/cursor-credits
2. Another option is the tool @Alexander Zakharov built:
    - It lets users redeem a code with their name and email, so it works for free with more users
    - Access here: https://github.com/cursorcommunityled/cursor-credits-portal
3. Another option is to generate QR codes for each link with the tool @Yahya Qureshi made. print them, cut them up, and distribute them as people check in. 
    - Access here: https://cursor-qr.vercel.app/
    - Optional: Print QRs on double-sided cardstock with the Cursor logo on the back using the design below or generate your own design here: [https://image-grid-pdf-generator.vercel.app/](https://image-grid-pdf-generator.vercel.app/)
        
        [cursor-logo-3x3-grid.pdf](Hackathon%20format/cursor-logo-3x3-grid.pdf)
        
4. If you plan to have a Discord for your event, you can use this Discord bot @David Zhang built
- [https://github.com/Git-on-my-level/discord-unique-code-distributor](https://github.com/Git-on-my-level/discord-unique-code-distributor)
- Creating a Discord bot for your own server is fast and free!

 **5. Another option is the validation landing page @ArturoRiosMock built:**
It allows registered attendees to claim credits by verifying their email against your guest list, ensuring only confirmed participants get access.
Access here: [https://github.com/ArturoRiosMock/cafe-cursor](https://github.com/ArturoRiosMock/cafe-cursor)

### Unclaimed credits-

### Judging

- If your hackathon requires participants to build projects from scratch and not bring existing projects, @David Zhang put together a tool suite for his own hackathon that you can repurpose:
    - [https://github.com/Git-on-my-level/cursor-hackathon-hcmc-2025](https://github.com/Git-on-my-level/cursor-hackathon-hcmc-2025)
    - Checks for obvious signs of re-using past projects, whether the repo looks sane for what they're demoing, etc...
    - Note that this repo is not cleaned up for new hackathons, so you’ll need to fork the project and delete existing data
    - You can chat with AI to understand how it works, or read the README, but you will need other tools (like Google Forms, Typeform, etc…) to collect user submissions and export it as a CSV for the tools to read

### Winners

- Ideally use a dedicated network for any presentations; if not you risk the wifi going down given everyone may be using the same wifi.
- Use a voting app like [Slido](https://www.slido.com/) to let the participants choose the winners. We might want to build an internal one for Ambassadors to use for hackathons.
- Fun idea might be to encourage winners to share their Cursor chats with attendees to see what their agent usage looked like.
- We can provide Cursor credits to a few of the winners (i.e. $200+ of credits to the top 3-5 winners, can be flexible here) please message @Ben Lang the Cursor emails of the winners after so that he can add that to their accounts.

### Notes

- Read through learnings from previous hackathons: ‣
- Summary of the notes here:
    
    ## Event Planning & Community Management
    
    - Manuel created GitHub documentation for Tallinn hackathons
    - 20-30% retention rate from first to second events
    - Email list building via Luma for GDPR compliance
    - WhatsApp groups effective in Europe (40% conversion in Romania)
    - Participant management: Individual registration required (prevents team captain credit theft)
    - Maximum team size: 4 people. Allow participants to decide teams during the event.
    
    ## Setup & Problem Solving (Common Issues)
    
    - Development environment setup biggest challenge for non-developers.
        - HTML-based runtime solution (single file with npm capabilities)
        - For shorter hackathons provide instructions beforehand; for longer ones, do a setup presentation
        - Ask experienced members of each team to assist
    - Capacity: WiFi and power outlets for all participants.
    - Food: Provide much more food than calculated (e.g. 32 extra pizzas for <200 people).
    - Merch: Distribute merch during registration to prevent theft/chaos.
    - Energy: Use background music (e.g. progressive house).
    
    ## Competition Format & Judging
    
    - Partnering with NGOs and corporations; mandatory open-source code sharing
    - Move from individual pitches to collaborative projects
    - Time tracking: 3-5 minutes max per team demo (AV testing critical before demos)
    - Judging system innovation (Jan 2026 update):
        - Pairwise comparison system instead of absolute scoring creates ELO-style rankings and reduces bias. Scales better beyond 30 teams (approx 1 hr to judge 150 teams).
        - Platform will automatically process team matchups and generate objective shortlist.
        - Add a Golden buzzer feature for standout projects.
    
    ## Sponsorship & Promotions
    
    - Many tool sponsors (like Convex, ElevenLabs) accessible on Twitter / Socials. Local startups want talent pipeline access.
    - Anthropic, OpenAI partnerships through founder programs.
    - Promotion: Create FOMO with limited spots, build credibility with serious builders, do weekly LinkedIn momentum posts, and partner closely with the local developer scene.
    - Choose duration strategically: 6-8 hrs is standard but limits first-timer onboarding. 24hrs needs more sponsor involvement.

![Cursor hackathon in Tallinn](Hackathon%20format/image%201.png)

Cursor hackathon in Tallinn

![Cursor hackathon in Tallinn](Hackathon%20format/2.jpg)

Cursor hackathon in Tallinn

![Cursor hackathon in Shenzhen](Hackathon%20format/image%202.png)

Cursor hackathon in Shenzhen

![Hackathon in Nairobi ](Hackathon%20format/1000303494.jpg)

Hackathon in Nairobi 

![Cursor hackathon in Shenzhen](Hackathon%20format/image%203.png)

Cursor hackathon in Shenzhen

![Hackathon in Nairobi ](Hackathon%20format/1000303493.jpg)

Hackathon in Nairobi 

---

[archive](https://www.notion.so/archive-312e694fe88f81a98a71f39331abcc53?pvs=21)