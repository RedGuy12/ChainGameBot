import dotenv from "dotenv";
import fileSystem from "fs";
import mongoose from "mongoose";
import {Client, Intents as intents, MessageEmbed, TextChannel} from "discord.js";
import isWord from "./isWord";

process.on("unhandledException", console.error);
process.on("unhandledRejection", console.error);

// set up process.env
dotenv.config();

const ME_ID = "771422735486156811";

//set up db stuffs

await mongoose.connect(`${process.env.MONGO_URL}?retryWrites=true&w=majority`, {
	appName: "bot",
});
mongoose.connection.on("error", console.error);

const databases = {};

const games = await Promise.all(
	fileSystem.readdirSync(new URL("./games", import.meta.url)).map(async (file) => {
		return (await import("./games/" + file)).default;
	}),
);

const guildSchema = {
	id: {
		type: String,
		unique: true,
		required: true,
	},
	logs: { type: String },
};
games.forEach((game) => {
	databases[`${game.name}`] = mongoose.model(
		game.name,
		new mongoose.Schema({
			word: {
				type: String,
				required: true,
				lowercase: true,
				trim: true,
			},
			author: {
				type: String,
				required: true,
			},
			id: {
				type: String,
				unique: true,
				required: true,
			},
			index: {
				type: Number,
				required: true,
				unique: false,
			},
			guild: {
				type: String,
				required: true,
			},
		}),
	);
	guildSchema[`${game.name}`] = {
		type: String,
	};
	guildSchema[`logs_${game.name}`] = {
		type: String,
	};
});
databases.Guilds = mongoose.model("Guild", new mongoose.Schema(guildSchema));

const Discord = new Client({
	intents: [
		intents.FLAGS.GUILDS,
		intents.FLAGS.GUILD_MESSAGES,
		intents.FLAGS.GUILD_MESSAGE_REACTIONS,
		intents.FLAGS.DIRECT_MESSAGES,
		intents.FLAGS.DIRECT_MESSAGE_TYPING,
	],
});
Discord.once("ready", () => console.log(`Connected to Discord with ID`, Discord.application?.id))
	.on("disconnect", () => console.warn("Disconnected from Discord"))
	.on("debug", console.debug)
	.on("warn", console.warn)
	.on("error", console.error)
	.on("typingStart", async (msg) => {
		await msg.channel.send({ content: "No DMs, sorry!" });
	})
	.on("messageCreate", async (msg) => {
		// todo also post channel it was from
		if (!msg.guild) {
			await msg.reply({ content: "No DMs, sorry!" });
			return;
		}
		if (msg.author.id === Discord.user?.id) return;
		const guildInfo = await databases.Guilds.findOne({ id: msg.guild.id || "" }).exec();
		if (!guildInfo) return;
		const game = games.find((game) => guildInfo[game.name] === msg.channel.id);
		if (!game) return;
		const logChannelId = guildInfo["logs_" + game.name] || guildInfo.logs;
		if (!logChannelId) return;
		/** @type {TextChannel | undefined} */
		// @ts-expect-error -- It's impossible for this to be set as a non-text channel.
		const ruleChannel = await Discord.channels.fetch(logChannelId);
		if (!ruleChannel) return;
		try {
			const word = msg.content.toLowerCase().trim().replaceAll("`", "'");

			if (game.match && !game.match.test(word)) {
				msg.delete();

				const embed = new MessageEmbed()
					.setTitle("Invalid character sent!")
					.setAuthor(msg.author.tag, msg.author.displayAvatarURL())
					.setDescription(`\`${word}\` contains invalid characters!`);

				ruleChannel.send({
					content: msg.author.toString(),
					embeds: [embed],
				});
				return;
			}

			// use Wiktionary's API to determine if it is a word
			if (game.validWordsOnly) {
				if (!(await isWord(word) || await isWord(msg.content))) {
					msg.delete();

					const embed = new MessageEmbed()
						.setTitle("Not a word!")
						.setAuthor(msg.author.tag, msg.author.displayAvatarURL())
						.setDescription(`\`${word}\` is not a word!`);

					ruleChannel.send({
						content: msg.author.toString(),
						embeds: [embed],
					});
					return;
				}
			}

			const gameDatabase = databases[game.name];
			const lastWord = await gameDatabase
				.findOne({guild: msg.guild.id})
				.sort({index: -1})
				.exec();

			if (game.manualCheck) {
				const manualCheckResult = game.manualCheck(word, lastWord);
				if (manualCheckResult !== true) {
					msg.delete();
					ruleChannel.send({
						content: msg.author.toString(),
						embeds: [
							manualCheckResult.setAuthor(
								msg.author.tag,
								msg.author.displayAvatarURL(),
							),
						],
					});
					return;
				}
			}

			if (
				msg.guild.id !== "823941138653773868" &&
				!game.twiceInRow &&
				lastWord?.author === msg.author.id
			) {
				msg.delete();

				const embed = new MessageEmbed()
					.setTitle("Posting twice in a row!")
					.setAuthor(msg.author.tag, msg.author.displayAvatarURL())
					.setDescription(`No posting twice in a row allowed!`);

				ruleChannel.send({
					content: msg.author.toString(),
					embeds: [embed],
				});
				return;
			}

			if (!game.duplicates) {
				// determine if it has been used before
				const used = await gameDatabase.findOne({ word, guild: msg.guild.id }).exec();
				if (used) {
					const usedMsg = await msg.channel.messages.fetch(used.id).catch(() => {});
					if (usedMsg) {
						msg.delete();
						const embed = new MessageEmbed()
							.setTitle("Duplicate word!")
							.setAuthor(msg.author.tag, msg.author.displayAvatarURL())
							.setDescription(
								`\`${word}\` has [been used before](https://discord.com/channels/${usedMsg.guild.id}/${usedMsg.channel.id}/${used.id}) by <@${used.author}>!`,
							)
							.setThumbnail(
								(await Discord.users.fetch(used.author)).displayAvatarURL(),
							);

						ruleChannel.send({
							content: msg.author.toString(),
							embeds: [embed],
						});
						return;
					} else gameDatabase.deleteOne({ _id: used._id });
				}
			}

			// all checks out, add to db
			await new gameDatabase({
				word,
				author: msg.author.id,
				id: msg.id,
				index: (lastWord?.index ?? -1) + 1,
				guild: msg.guild.id,
			}).save();

			await msg.react("👍");
			return;
		} catch (error) {
			handleError(error, (data) => ruleChannel.send(data), ruleChannel);
		}
	})
	.on("interactionCreate", async (interaction) => {
		try {
			if (!interaction.isCommand()) return;

			if (!interaction.guild)
				return await interaction.reply({ content: "No DMs, sorry!", ephemeral: true });

			if (interaction.commandName === "ping") {
				return await interaction.reply({ content: "Pong!", ephemeral: true });
			}
			if (interaction.commandName === "invite") {
				return await interaction.reply({
					content: `https://discord.com/api/oauth2/authorize?client_id=${Discord.user?.id}&permissions=2147838016&scope=bot%20applications.commands`,
					ephemeral: true,
				});
			}

			const guildInfo = await databases.Guilds.findOne({ id: interaction.guild.id });

			if (interaction.commandName === "set-last") {
				if (!guildInfo) return;
				if (
					!interaction.member?.permissionsIn?.(interaction.channel).has("MANAGE_MESSAGES")
				) {
					return await interaction.reply({
						content: "Lacking Manage Messages permission, sorry!",
						ephemeral: true,
					});
				}

				const last = interaction.options.getString("message");
				if (!last) {
					return interaction.reply({
						content: "Please specify what to force-post!",
						ephemeral: true,
					});
				}
				const game = games.find((game) => guildInfo[game.name] === interaction.channel?.id);
				if (!game) return;

				const gameDatabase = databases[game.name];

				const msg = await interaction.reply({
					content: last.replace(/([*_~|<`])/g, "\\$1"),
					fetchReply: true,
				});
				await Promise.all([
					new gameDatabase({
						word: last,
						author: Discord.user?.id,
						id: msg.id,
						index:
							((
								await gameDatabase
									.findOne({ guild: interaction.guild.id })
									.sort({ index: -1 })
									.exec()
							)?.index ?? -1) + 1,
						guild: interaction.guild.id,
					}).save(),
					msg?.react?.("👍"),
				]);
				return;
			}

			if (interaction.commandName === "set-game") {
				if (!interaction.member?.permissionsIn?.(interaction.channel).has("MANAGE_GUILD")) {
					return await interaction.reply({
						content: "Lacking Manage Server permission, sorry!",
						ephemeral: true,
					});
				}

				const game = interaction.options.getString("game");
				if (!game)
					return interaction.reply({
						content: "Please specify a game!",
						ephemeral: true,
					});
				if (guildInfo) {
					if (
						Object.values({ ...guildInfo, id: undefined }).includes(
							interaction.channel?.id,
						)
					) {
						return interaction.reply({
							content: "This channel is already in use!",
							ephemeral: true,
						});
					}
					await databases.Guilds.updateOne(
						{ id: interaction.guild.id },
						{ [game]: interaction.channel?.id },
					);
				} else {
					await new databases.Guilds({
						id: interaction.guild.id,
						[game]: interaction.channel?.id,
					}).save();
				}
				await interaction.reply({
					content: "This channel has been initialized for a game of " + game + "!",
				});
				// purge channel option
			}
			if (interaction.commandName === "set-logs") {
				if (!interaction.member?.permissionsIn?.(interaction.channel).has("MANAGE_GUILD"))
					return await interaction.reply({
						content: "Lacking Manage Server permission, sorry!",
						ephemeral: true,
					});
				const game = interaction.options.getString("game");
				if (game) {
					if (guildInfo) {
						if (
							Object.entries({ ...guildInfo, id: undefined }).find(
								(item) =>
									!item[0].startsWith("logs_") &&
									item[1] === interaction.channel?.id,
							)
						) {
							return interaction.reply({
								content: "This channel is already in use!",
								ephemeral: true,
							});
						}
						await databases.Guilds.updateOne(
							{ id: interaction.guild.id },
							{ ["logs_" + game]: interaction.channel?.id },
						);
					} else
						await new databases.Guilds({
							id: interaction.guild.id,
							["logs_" + game]: interaction.channel?.id,
						}).save();
					await interaction.reply({
						content: "Logs for " + game + " will be posted here!",
					});
				} else {
					if (guildInfo)
						await databases.Guilds.updateOne(
							{ id: interaction.guild.id },
							{ logs: interaction.channel?.id },
						);
					else
						await new databases.Guilds({
							id: interaction.guild.id,
							logs: interaction.channel?.id,
						}).save();
					await interaction.reply({
						content: "Logs will be posted here if no game-specific channel is set!",
					});
				}
				// purge channel option
			}
		} catch (error) {
			await handleError(
				error,
				async (data) => (await interaction?.reply?.(data)) || (() => {}),
				interaction.channel,
			);
		}
	});

Discord.login(process.env.BOT_TOKEN);

async function handleError(error, send, ruleChannel) {
	try {
		console.error(error);

		const pingMe = await ruleChannel.guild.members.fetch(ME_ID);
		const embed = new MessageEmbed()
			.setTitle("Error!")
			.setDescription(
				`Uhoh! I found an error!\n\`\`\`json\n${JSON.stringify(error).replaceAll(
					"```",
					"[3 backticks]",
				)}\`\`\``,
			);
		if (pingMe) {
			send({
				content: "<@" + ME_ID + ">",
				embeds: [embed],
			});
		} else {
			const message = await send({
				embeds: [embed],
			});
			(await Discord.users.fetch(ME_ID)).send({
				content: message.url,
				embeds: [embed],
			});
		}
		return;
	} catch (errorError) {
		console.error(errorError);
	}
}
