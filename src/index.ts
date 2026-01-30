import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/racing/irl';

const agent = await createAgent({
  name: 'indycar-data',
  version: '1.0.0',
  description: 'Real-time IndyCar racing data: schedules, race events, news, and season reports via ESPN',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch real data ===
async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN API error: ${response.status}`);
  return response.json();
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of current IndyCar season and next race - try before you buy',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const data = await fetchJSON(`${ESPN_BASE}/scoreboard`);
    
    const league = data.leagues?.[0];
    const calendar = league?.calendar || [];
    const nextEvent = data.events?.[0];
    
    // Find next upcoming race
    const now = new Date();
    const upcomingRaces = calendar
      .filter((race: any) => new Date(race.startDate) > now)
      .slice(0, 3);
    
    return {
      output: {
        season: {
          year: league?.season?.year,
          name: league?.name,
          abbreviation: league?.abbreviation,
        },
        nextRace: nextEvent ? {
          id: nextEvent.id,
          name: nextEvent.name,
          date: nextEvent.date,
          status: nextEvent.competitions?.[0]?.status?.type?.description,
          broadcast: nextEvent.competitions?.[0]?.broadcast,
        } : null,
        upcomingCount: upcomingRaces.length,
        totalRaces: calendar.length,
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN IndyCar API (live)',
      },
    };
  },
});

// === PAID ENDPOINT 1: Full Schedule ($0.001) ===
addEntrypoint({
  key: 'schedule',
  description: 'Full IndyCar season schedule with all race dates and venues',
  input: z.object({
    year: z.number().optional(),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchJSON(`${ESPN_BASE}/scoreboard`);
    
    const league = data.leagues?.[0];
    const calendar = league?.calendar || [];
    
    const races = calendar.map((race: any) => ({
      name: race.label,
      date: race.startDate,
      endDate: race.endDate,
    }));
    
    return {
      output: {
        season: league?.season?.year,
        totalRaces: races.length,
        races,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Race Details ($0.002) ===
addEntrypoint({
  key: 'race',
  description: 'Detailed info for a specific race by name search',
  input: z.object({
    query: z.string().describe('Race name to search for (e.g., "Indianapolis 500", "Long Beach")'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchJSON(`${ESPN_BASE}/scoreboard`);
    
    const league = data.leagues?.[0];
    const calendar = league?.calendar || [];
    const events = data.events || [];
    
    const searchLower = ctx.input.query.toLowerCase();
    
    // Search in calendar
    const matchingRaces = calendar.filter((race: any) =>
      race.label?.toLowerCase().includes(searchLower)
    );
    
    // Search in events for more details
    const matchingEvents = events.filter((event: any) =>
      event.name?.toLowerCase().includes(searchLower)
    );
    
    const results = matchingRaces.map((race: any) => {
      const eventMatch = matchingEvents.find((e: any) =>
        e.name?.toLowerCase().includes(race.label?.toLowerCase())
      );
      
      return {
        name: race.label,
        date: race.startDate,
        eventId: eventMatch?.id,
        status: eventMatch?.competitions?.[0]?.status?.type?.description,
        broadcast: eventMatch?.competitions?.[0]?.broadcast,
        venue: eventMatch?.competitions?.[0]?.venue?.fullName,
      };
    });
    
    return {
      output: {
        query: ctx.input.query,
        matchCount: results.length,
        races: results,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: News ($0.002) ===
addEntrypoint({
  key: 'news',
  description: 'Latest IndyCar news headlines and articles',
  input: z.object({
    limit: z.number().min(1).max(25).optional().default(10),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchJSON(`${ESPN_BASE}/news`);
    
    const articles = (data.articles || []).slice(0, ctx.input.limit).map((article: any) => ({
      id: article.id,
      headline: article.headline,
      description: article.description,
      published: article.published,
      url: article.links?.web?.href,
      imageUrl: article.images?.[0]?.url,
    }));
    
    return {
      output: {
        totalArticles: articles.length,
        articles,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Upcoming Races ($0.002) ===
addEntrypoint({
  key: 'upcoming',
  description: 'Get upcoming races within a time window',
  input: z.object({
    days: z.number().min(1).max(365).optional().default(30),
    limit: z.number().min(1).max(20).optional().default(5),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchJSON(`${ESPN_BASE}/scoreboard`);
    
    const calendar = data.leagues?.[0]?.calendar || [];
    const now = new Date();
    const cutoff = new Date(now.getTime() + ctx.input.days * 24 * 60 * 60 * 1000);
    
    const upcoming = calendar
      .filter((race: any) => {
        const raceDate = new Date(race.startDate);
        return raceDate > now && raceDate <= cutoff;
      })
      .slice(0, ctx.input.limit)
      .map((race: any) => {
        const raceDate = new Date(race.startDate);
        const daysUntil = Math.ceil((raceDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return {
          name: race.label,
          date: race.startDate,
          daysUntil,
        };
      });
    
    return {
      output: {
        daysWindow: ctx.input.days,
        upcomingCount: upcoming.length,
        races: upcoming,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Full Report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive IndyCar report: season overview, full schedule, and latest news',
  input: z.object({
    newsLimit: z.number().min(1).max(10).optional().default(5),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const [scheduleData, newsData] = await Promise.all([
      fetchJSON(`${ESPN_BASE}/scoreboard`),
      fetchJSON(`${ESPN_BASE}/news`),
    ]);
    
    const league = scheduleData.leagues?.[0];
    const calendar = league?.calendar || [];
    const now = new Date();
    
    // Split into completed and upcoming
    const completed = calendar.filter((r: any) => new Date(r.startDate) < now);
    const upcoming = calendar.filter((r: any) => new Date(r.startDate) >= now);
    
    // Get news
    const news = (newsData.articles || []).slice(0, ctx.input.newsLimit).map((a: any) => ({
      headline: a.headline,
      description: a.description,
      published: a.published,
      url: a.links?.web?.href,
    }));
    
    // Next race details
    const nextRace = upcoming[0];
    const nextRaceDate = nextRace ? new Date(nextRace.startDate) : null;
    const daysUntilNext = nextRaceDate 
      ? Math.ceil((nextRaceDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    
    return {
      output: {
        season: {
          year: league?.season?.year,
          name: league?.name,
          totalRaces: calendar.length,
          completedRaces: completed.length,
          remainingRaces: upcoming.length,
        },
        nextRace: nextRace ? {
          name: nextRace.label,
          date: nextRace.startDate,
          daysUntil: daysUntilNext,
        } : null,
        schedule: {
          completed: completed.map((r: any) => ({ name: r.label, date: r.startDate })),
          upcoming: upcoming.map((r: any) => ({ name: r.label, date: r.startDate })),
        },
        latestNews: news,
        generatedAt: new Date().toISOString(),
        dataSources: ['ESPN IndyCar Scoreboard API', 'ESPN IndyCar News API'],
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`IndyCar Data Agent running on port ${port}`);

export default { port, fetch: app.fetch };
