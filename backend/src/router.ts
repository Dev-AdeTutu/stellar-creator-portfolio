import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from './trpc-setup';
import { prisma } from '@/lib/prisma';

// Root router with Prisma-backed queries
export const appRouter = router({
  // Public query to fetch bounties with optional filtering
  bounties: router({
    list: publicProcedure
      .input(
        z.object({
          take: z.number().int().positive().default(10),
          cursor: z.string().optional(),
          status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
        })
      )
      .query(async ({ input }) => {
        const bounties = await prisma.bounty.findMany({
          take: input.take + 1, // +1 to determine hasNextPage
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }), // skip cursor itself
          where: {
            ...(input.status && { status: input.status }),
          },
          select: {
            id: true,
            title: true,
            description: true,
            budget: true,
            deadline: true,
            status: true,
            category: true,
            tags: true,
            difficulty: true,
            createdAt: true,
            creator: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        const hasNextPage = bounties.length > input.take;
        if (hasNextPage) bounties.pop(); // Remove the extra item

        const nextCursor = bounties.length > 0 ? bounties[bounties.length - 1].id : null;

        return {
          bounties,
          nextCursor,
          hasNextPage,
        };
      }),

    // Protected query to fetch creator's own bounties
    myBounties: protectedProcedure
      .input(
        z.object({
          take: z.number().int().positive().default(10),
          cursor: z.string().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const bounties = await prisma.bounty.findMany({
          take: input.take + 1,
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
          where: {
            creatorId: ctx.user!.id,
          },
          select: {
            id: true,
            title: true,
            description: true,
            budget: true,
            deadline: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });

        const hasNextPage = bounties.length > input.take;
        if (hasNextPage) bounties.pop();

        const nextCursor = bounties.length > 0 ? bounties[bounties.length - 1].id : null;

        return {
          bounties,
          nextCursor,
          hasNextPage,
        };
      }),

    // Public query to fetch single bounty by id
    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        return await prisma.bounty.findUnique({
          where: { id: input.id },
          select: {
            id: true,
            title: true,
            description: true,
            budget: true,
            deadline: true,
            status: true,
            category: true,
            tags: true,
            difficulty: true,
            creator: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            createdAt: true,
            updatedAt: true,
          },
        });
      }),

    // Create new bounty
    create: protectedProcedure
      .input(
        z.object({
          title: z.string().min(1),
          description: z.string().min(1),
          budget: z.number().positive(),
          deadline: z.date(),
          category: z.string(),
          tags: z.array(z.string()),
          difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
        })
      )
      .mutation(async ({ ctx, input }) => {
        return await prisma.bounty.create({
          data: {
            ...input,
            creatorId: ctx.user!.id,
            status: 'OPEN',
          },
        });
      }),
  }),

  // Creators endpoints
  creators: router({
    list: publicProcedure
      .input(
        z.object({
          take: z.number().int().positive().default(10),
          cursor: z.string().optional(),
          discipline: z.string().optional(),
          search: z.string().optional(),
        })
      )
      .query(async ({ input }) => {
        const where: any = {};
        if (input.discipline) {
          where.discipline = input.discipline;
        }
        if (input.search) {
          where.OR = [
            { name: { contains: input.search, mode: 'insensitive' } },
            { bio: { contains: input.search, mode: 'insensitive' } },
          ];
        }

        const creators = await prisma.creator.findMany({
          take: input.take + 1,
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
          where,
          select: {
            id: true,
            name: true,
            title: true,
            discipline: true,
            bio: true,
            avatar: true,
            hourlyRate: true,
            rating: true,
            reviewCount: true,
          },
          orderBy: { createdAt: 'desc' },
        });

        const hasNextPage = creators.length > input.take;
        if (hasNextPage) creators.pop();

        const nextCursor = creators.length > 0 ? creators[creators.length - 1].id : null;

        return {
          creators,
          nextCursor,
          hasNextPage,
        };
      }),

    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        return await prisma.creator.findUnique({
          where: { id: input.id },
          include: {
            projects: true,
            reviews: {
              take: 5,
              orderBy: { createdAt: 'desc' },
            },
          },
        });
      }),
  }),

  // Escrow endpoints
  escrow: router({
    create: protectedProcedure
      .input(
        z.object({
          bountyId: z.string(),
          payerAddress: z.string(),
          payeeAddress: z.string(),
          amount: z.number().positive(),
          token: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        // This would integrate with the Stellar escrow smart contract
        // For now, return a mock response
        return {
          escrowId: `escrow-${Date.now()}`,
          txHash: `tx-${Date.now()}`,
          operation: 'deposit',
          status: 'pending',
        };
      }),

    release: protectedProcedure
      .input(z.object({ escrowId: z.string() }))
      .mutation(async ({ input }) => {
        return {
          escrowId: input.escrowId,
          txHash: `tx-release-${Date.now()}`,
          operation: 'release',
          status: 'completed',
        };
      }),
  }),

  // Projects endpoints
  projects: router({
    create: protectedProcedure
      .input(
        z.object({
          title: z.string().min(1),
          category: z.string().min(1),
          description: z.string().min(1),
          tags: z.array(z.string()),
          year: z.number().int().min(2000).max(new Date().getFullYear()),
          link: z.string().url().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        return await prisma.project.create({
          data: {
            ...input,
            creatorId: ctx.user!.id,
          },
        });
      }),

    list: publicProcedure
      .input(
        z.object({
          creatorId: z.string().optional(),
          take: z.number().int().positive().default(10),
          cursor: z.string().optional(),
        })
      )
      .query(async ({ input }) => {
        const where = input.creatorId ? { creatorId: input.creatorId } : {};

        const projects = await prisma.project.findMany({
          take: input.take + 1,
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
          where,
          include: {
            creator: {
              select: { id: true, name: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        const hasNextPage = projects.length > input.take;
        if (hasNextPage) projects.pop();

        const nextCursor = projects.length > 0 ? projects[projects.length - 1].id : null;

        return {
          projects,
          nextCursor,
          hasNextPage,
        };
      }),
  }),

  // Analytics endpoints
  analytics: router({
    dashboard: protectedProcedure
      .input(
        z.object({
          period: z.enum(['7d', '30d', '90d', '1y']).default('30d'),
        })
      )
      .query(async ({ ctx, input }) => {
        // Get user's analytics data
        const user = ctx.user!;

        // This would calculate real metrics from bounties, applications, etc.
        return {
          earnings: {
            total: 12500,
            thisMonth: 3200,
            change: 15.3,
          },
          performance: {
            completionRate: 94,
            avgRating: 4.7,
            responseTime: '2h',
          },
          projects: {
            active: 3,
            completed: 28,
            pending: 5,
          },
        };
      }),
  }),

  // Availability calendar — Issue #792
  availability: router({
    list: publicProcedure
      .input(z.object({ creatorId: z.string(), month: z.date().optional() }))
      .query(async ({ input }) => {
        const month = input.month || new Date();
        const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
        const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);

        return await prisma.availability.findMany({
          where: {
            creatorId: input.creatorId,
            date: { gte: startOfMonth, lte: endOfMonth },
          },
          orderBy: { date: 'asc' },
        });
      }),

    set: protectedProcedure
      .input(
        z.object({
          date: z.date(),
          status: z.enum(['AVAILABLE', 'BUSY', 'UNAVAILABLE']),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const creatorProfile = await prisma.creatorProfile.findUnique({
          where: { userId: ctx.user!.id },
        });

        if (!creatorProfile) {
          throw new Error('Creator profile not found');
        }

        return await prisma.availability.upsert({
          where: { creatorId_date: { creatorId: creatorProfile.id, date: new Date(input.date) } },
          create: { creatorId: creatorProfile.id, date: new Date(input.date), status: input.status },
          update: { status: input.status },
        });
      }),

    delete: protectedProcedure
      .input(z.object({ date: z.date() }))
      .mutation(async ({ ctx, input }) => {
        const creatorProfile = await prisma.creatorProfile.findUnique({
          where: { userId: ctx.user!.id },
        });

        if (!creatorProfile) {
          throw new Error('Creator profile not found');
        }

        return await prisma.availability.delete({
          where: { creatorId_date: { creatorId: creatorProfile.id, date: new Date(input.date) } },
        });
      }),
  }),

  // Skill endorsements — Issue #793
  endorsements: router({
    endorse: protectedProcedure
      .input(z.object({ creatorId: z.string(), skill: z.string() }))
      .mutation(async ({ ctx, input }) => {
        return await prisma.endorsement.upsert({
          where: { endorserId_creatorId_skill: { endorserId: ctx.user!.id, creatorId: input.creatorId, skill: input.skill } },
          create: { endorserId: ctx.user!.id, creatorId: input.creatorId, skill: input.skill },
          update: { createdAt: new Date() },
        });
      }),

    counts: publicProcedure
      .input(z.object({ creatorId: z.string() }))
      .query(async ({ input }) => {
        const endorsements = await prisma.endorsement.groupBy({
          by: ['skill'],
          where: { creatorId: input.creatorId },
          _count: { skill: true },
          orderBy: { _count: { skill: 'desc' } },
          take: 10,
        });

        return endorsements.map(e => ({ skill: e.skill, count: e._count.skill }));
      }),

    topSkills: publicProcedure
      .input(z.object({ creatorId: z.string(), take: z.number().default(3) }))
      .query(async ({ input }) => {
        const endorsements = await prisma.endorsement.groupBy({
          by: ['skill'],
          where: { creatorId: input.creatorId },
          _count: { skill: true },
          orderBy: { _count: { skill: 'desc' } },
          take: input.take,
        });

        return endorsements.map(e => e.skill);
      }),

    hasEndorsed: protectedProcedure
      .input(z.object({ creatorId: z.string(), skill: z.string() }))
      .query(async ({ ctx, input }) => {
        const endorsement = await prisma.endorsement.findUnique({
          where: { endorserId_creatorId_skill: { endorserId: ctx.user!.id, creatorId: input.creatorId, skill: input.skill } },
        });

        return !!endorsement;
      }),
  }),
});

export type AppRouter = typeof appRouter;
